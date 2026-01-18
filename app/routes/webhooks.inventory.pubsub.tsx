import type { ActionFunctionArgs } from "react-router";
import { processInventoryUpdate } from "../services/inventory-sync.server";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";

/**
 * Pub/Sub message envelope from Google Cloud
 */
interface PubSubMessage {
  message: {
    data: string; // Base64 encoded
    messageId: string;
    publishTime: string;
    attributes?: Record<string, string>;
  };
  subscription: string;
}

/**
 * Webhook payload for inventory_levels/update (decoded from Pub/Sub)
 */
interface InventoryLevelUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
  updated_at: string;
  // Some Shopify webhook formats include shop in payload
  shop_domain?: string;
}

// Shopify webhook metadata is passed via Pub/Sub attributes with keys like:
// X-Shopify-Shop-Domain, X-Shopify-Topic, X-Shopify-API-Version, X-Shopify-Webhook-Id

/**
 * Handles inventory webhooks pushed via Google Cloud Pub/Sub.
 *
 * In production, Shopify webhooks are received by a Cloud Function or Cloud Run
 * service that publishes them to Pub/Sub for reliable processing. This endpoint
 * receives the push from Pub/Sub.
 *
 * Benefits:
 * - Handles burst traffic (600+ inventory changes at once)
 * - Automatic retries with exponential backoff
 * - Decouples webhook receipt from processing
 *
 * Flow:
 * 1. Shopify → Cloud Run/Function → Pub/Sub → This endpoint
 * 2. Message includes original webhook payload + shop metadata
 * 3. We process and acknowledge (200) or fail (non-200) for retry
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Verify this is coming from our Pub/Sub subscription
  // In production, you'd verify the Authorization header contains a valid OIDC token
  // For now, we'll trust the request

  let pubsubMessage: PubSubMessage;

  try {
    pubsubMessage = (await request.json()) as PubSubMessage;
  } catch {
    console.error("[Pub/Sub] Invalid JSON payload");
    return new Response("Invalid JSON", { status: 400 });
  }

  const { message } = pubsubMessage;

  if (!message?.data) {
    console.error("[Pub/Sub] Missing message data");
    return new Response("Missing message data", { status: 400 });
  }

  // Decode the base64 payload
  let inventoryPayload: InventoryLevelUpdatePayload | null;
  let decoded: string;
  try {
    decoded = Buffer.from(message.data, "base64").toString("utf-8");
    console.log("[Pub/Sub] Decoded payload:", decoded);
    inventoryPayload = JSON.parse(
      decoded,
    ) as InventoryLevelUpdatePayload | null;
  } catch (error) {
    console.error("[Pub/Sub] Failed to decode message data:", error);
    return new Response("Invalid message data", { status: 400 });
  }

  // Handle null/empty payload (e.g., from test webhooks)
  if (!inventoryPayload || typeof inventoryPayload !== "object") {
    console.log(
      "[Pub/Sub] Empty or invalid payload, acknowledging test webhook",
    );
    return new Response(null, { status: 200 });
  }

  // Validate required fields
  if (
    inventoryPayload.inventory_item_id === undefined ||
    inventoryPayload.location_id === undefined ||
    inventoryPayload.available === undefined
  ) {
    console.log("[Pub/Sub] Missing required fields in payload, acknowledging");
    console.log("[Pub/Sub] Payload:", JSON.stringify(inventoryPayload));
    return new Response(null, { status: 200 });
  }

  // Extract shop from attributes (set by Shopify when publishing to Pub/Sub)
  // Shopify uses 'X-Shopify-Shop-Domain' as the attribute key
  const attributes = message.attributes;

  // Log all attributes to debug
  console.log(
    "[Pub/Sub] Message attributes:",
    JSON.stringify(attributes ?? {}),
  );

  // Shopify may use different attribute keys - check attributes and payload
  const shop =
    attributes?.["X-Shopify-Shop-Domain"] ??
    attributes?.["shop"] ??
    attributes?.["shopDomain"] ??
    inventoryPayload.shop_domain;

  if (!shop) {
    console.error(
      "[Pub/Sub] Missing shop attribute. Available attributes:",
      Object.keys(attributes ?? {}),
    );
    console.error("[Pub/Sub] Payload keys:", Object.keys(inventoryPayload));
    return new Response("Missing shop attribute", { status: 400 });
  }

  console.log(
    `[Pub/Sub] Processing inventory update for ${shop}: ` +
      `item=${inventoryPayload.inventory_item_id}, ` +
      `location=${inventoryPayload.location_id}, ` +
      `available=${inventoryPayload.available}`,
  );

  // Check for duplicate message (Pub/Sub at-least-once delivery)
  const messageId = message.messageId;
  const existingLock = await db.syncLock.findUnique({
    where: { id: `pubsub-${messageId}` },
  });

  if (existingLock) {
    console.log(`[Pub/Sub] Duplicate message ${messageId}, acknowledging`);
    return new Response(null, { status: 200 });
  }

  // Create a lock for this message
  try {
    await db.syncLock.create({
      data: {
        id: `pubsub-${messageId}`,
        bundleId: "pubsub-dedup",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hour TTL
      },
    });
  } catch {
    // Lock already exists (race condition), skip
    console.log(
      `[Pub/Sub] Race condition on message ${messageId}, acknowledging`,
    );
    return new Response(null, { status: 200 });
  }

  try {
    // Get admin API access for this shop using stored session
    const { admin } = await unauthenticated.admin(shop);

    const result = await processInventoryUpdate(admin, {
      inventoryItemId: inventoryPayload.inventory_item_id,
      locationId: inventoryPayload.location_id,
      available: inventoryPayload.available,
      shop,
    });

    if (result.skipped) {
      console.log(`[Pub/Sub] Skipped: ${result.skipped}`);
    } else {
      console.log(
        `[Pub/Sub] Processed: ${result.bundlesAffected} bundles, ${result.adjustmentsMade} adjustments`,
      );
    }

    // Acknowledge the message (200 response)
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("[Pub/Sub] Failed to process inventory update:", error);

    // Delete the lock so the message can be retried
    await db.syncLock
      .delete({
        where: { id: `pubsub-${messageId}` },
      })
      .catch(() => {
        // Ignore if already deleted
      });

    // Return 500 to trigger Pub/Sub retry with exponential backoff
    return new Response("Processing failed", { status: 500 });
  }
};
