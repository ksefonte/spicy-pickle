import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

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
 * When inventory changes, we need to:
 * 1. Check if the changed variant is part of any bundle
 * 2. If so, recalculate availability for all related variants
 * 3. Update Shopify inventory accordingly
 *
 * For now, this is a placeholder that logs the webhook.
 * Full implementation will be added in Phase 3.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const inventoryPayload = payload as InventoryLevelUpdatePayload;

  console.log(
    `Inventory update: item=${inventoryPayload.inventory_item_id}, ` +
      `location=${inventoryPayload.location_id}, ` +
      `available=${inventoryPayload.available}`,
  );

  // TODO (Phase 3): Implement bundle sync logic
  // 1. Look up variant GID from inventory_item_id
  // 2. Check if variant is part of any bundle (as parent or child)
  // 3. If yes, acquire sync lock (idempotency)
  // 4. Calculate new availability for all related variants
  // 5. Batch update inventory via GraphQL
  // 6. Release sync lock

  return new Response(null, { status: 200 });
};
