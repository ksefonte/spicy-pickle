import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processInventoryUpdate } from "../services/inventory-sync.server";

/**
 * Webhook payload for inventory_levels/update
 * @see https://shopify.dev/docs/api/webhooks/inventory-levels-update
 */
interface InventoryLevelUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
  updated_at: string;
}

/**
 * Handles inventory_levels/update webhooks from Shopify.
 *
 * This is the entry point for the bundle inventory sync feature.
 * When inventory changes, we:
 * 1. Check if the changed variant is part of any bundle
 * 2. If so, recalculate availability for all related variants
 * 3. Update Shopify inventory accordingly
 *
 * The sync service handles idempotency via SyncLock to prevent:
 * - Duplicate processing of the same webhook
 * - Infinite loops from our own inventory updates
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`[Webhook] Received ${topic} for ${shop}`);

  const inventoryPayload = payload as InventoryLevelUpdatePayload;

  console.log(
    `[Webhook] Inventory update: item=${inventoryPayload.inventory_item_id}, ` +
      `location=${inventoryPayload.location_id}, ` +
      `available=${inventoryPayload.available}`,
  );

  if (!admin) {
    console.error("[Webhook] No admin API access available");
    return new Response(null, { status: 200 });
  }

  try {
    const result = await processInventoryUpdate(admin, {
      inventoryItemId: inventoryPayload.inventory_item_id,
      locationId: inventoryPayload.location_id,
      available: inventoryPayload.available,
      shop,
    });

    if (result.skipped) {
      console.log(`[Webhook] Skipped: ${result.skipped}`);
    } else {
      console.log(
        `[Webhook] Processed: ${result.bundlesAffected} bundles, ${result.adjustmentsMade} adjustments`,
      );
    }

    if (result.error) {
      console.error(`[Webhook] Error: ${result.error}`);
    }
  } catch (error) {
    console.error("[Webhook] Failed to process inventory update:", error);
    // Still return 200 to acknowledge the webhook
    // Shopify will retry on 4xx/5xx responses
  }

  return new Response(null, { status: 200 });
};
