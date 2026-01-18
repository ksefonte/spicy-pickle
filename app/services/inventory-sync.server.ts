/**
 * Inventory Sync Service
 *
 * Handles the synchronization of inventory levels across bundle variants.
 * When inventory changes on any variant that's part of a bundle, this service
 * recalculates and updates the availability of all related variants.
 *
 * Two types of bundles are supported:
 * 1. Same-product bundles (e.g., Single/4-Pack/24-Pack of the same product)
 *    - All variants share a common "base" inventory pool
 *    - Availability = floor(base_stock / multiplier)
 *
 * 2. Mixed bundles (variety packs with different products)
 *    - Availability = min(component_stock / component_quantity) across all components
 */

import db from "../db.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// ============================================================================
// Types
// ============================================================================

export interface InventoryUpdateEvent {
  inventoryItemId: number;
  locationId: number;
  available: number;
  shop: string;
}

export interface BundleWithChildren {
  id: string;
  shopId: string;
  name: string;
  parentGid: string;
  children: Array<{
    id: string;
    childGid: string;
    quantity: number;
  }>;
}

export interface VariantInventory {
  variantGid: string;
  inventoryItemId: string;
  available: number;
}

export interface InventoryAdjustment {
  inventoryItemId: string;
  locationId: string;
  delta: number;
}

export interface SyncResult {
  processed: boolean;
  bundlesAffected: number;
  adjustmentsMade: number;
  skipped?: string;
  error?: string;
}

// ============================================================================
// Core Calculation Functions
// ============================================================================

/**
 * Calculates the available quantity for a bundle variant based on physical stock.
 * @param physicalStock - The number of physical base units available
 * @param multiplier - The number of base units in this bundle variant (e.g., 24 for a 24-pack)
 * @returns The number of complete bundle variants available
 */
export function calculateBundleAvailability(
  physicalStock: number,
  multiplier: number,
): number {
  if (multiplier <= 0) {
    throw new Error("Multiplier must be a positive number");
  }
  return Math.floor(physicalStock / multiplier);
}

/**
 * Calculates availability for a mixed bundle (variety pack) based on component stock.
 * @param components - Array of {stock, quantity} for each component in the bundle
 * @returns The number of complete mixed bundles available
 */
export function calculateMixedBundleAvailability(
  components: Array<{ stock: number; quantity: number }>,
): number {
  if (components.length === 0) {
    return 0;
  }

  const availabilities = components.map((component) => {
    if (component.quantity <= 0) {
      throw new Error("Component quantity must be a positive number");
    }
    return Math.floor(component.stock / component.quantity);
  });

  return Math.min(...availabilities);
}

// ============================================================================
// Sync Lock Management (Idempotency)
// ============================================================================

const SYNC_LOCK_TTL_MS = 60 * 1000; // 1 minute TTL for sync locks

/**
 * Attempts to acquire a sync lock for a bundle.
 * Returns true if lock was acquired, false if already locked.
 */
export async function acquireSyncLock(
  lockId: string,
  bundleId: string,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SYNC_LOCK_TTL_MS);

  try {
    // Clean up expired locks first
    await db.syncLock.deleteMany({
      where: {
        expiresAt: { lt: now },
      },
    });

    // Try to create the lock
    await db.syncLock.create({
      data: {
        id: lockId,
        bundleId,
        expiresAt,
      },
    });

    return true;
  } catch {
    // Lock already exists (unique constraint violation)
    return false;
  }
}

/**
 * Releases a sync lock.
 */
export async function releaseSyncLock(lockId: string): Promise<void> {
  await db.syncLock
    .delete({
      where: { id: lockId },
    })
    .catch(() => {
      // Lock may have already expired and been cleaned up
    });
}

// ============================================================================
// Bundle Lookup
// ============================================================================

/**
 * Finds all bundles that contain the given variant (as parent or child).
 */
export async function findBundlesForVariant(
  shop: string,
  variantGid: string,
): Promise<BundleWithChildren[]> {
  // Find bundles where this variant is the parent
  const parentBundles = await db.bundle.findMany({
    where: {
      shopId: shop,
      parentGid: variantGid,
    },
    include: {
      children: true,
    },
  });

  // Find bundles where this variant is a child
  const childBundles = await db.bundle.findMany({
    where: {
      shopId: shop,
      children: {
        some: {
          childGid: variantGid,
        },
      },
    },
    include: {
      children: true,
    },
  });

  // Combine and deduplicate
  const bundleMap = new Map<string, BundleWithChildren>();

  for (const bundle of [...parentBundles, ...childBundles]) {
    bundleMap.set(bundle.id, bundle);
  }

  return Array.from(bundleMap.values());
}

/**
 * Gets the inventory item ID for a variant GID using GraphQL.
 */
export async function getInventoryItemForVariant(
  admin: AdminApiContext,
  variantGid: string,
): Promise<string | null> {
  const response = await admin.graphql(
    `#graphql
      query getVariantInventoryItem($id: ID!) {
        productVariant(id: $id) {
          inventoryItem {
            id
          }
        }
      }
    `,
    { variables: { id: variantGid } },
  );

  const data = await response.json();
  return data.data?.productVariant?.inventoryItem?.id ?? null;
}

/**
 * Gets inventory levels for multiple inventory items at a specific location.
 */
export async function getInventoryLevels(
  admin: AdminApiContext,
  inventoryItemIds: string[],
  locationId: string,
): Promise<Map<string, number>> {
  const levels = new Map<string, number>();

  // Fetch in batches of 50 to avoid query limits
  const batchSize = 50;
  for (let i = 0; i < inventoryItemIds.length; i += batchSize) {
    const batch = inventoryItemIds.slice(i, i + batchSize);

    const response = await admin.graphql(
      `#graphql
        query getInventoryLevels($ids: [ID!]!, $locationId: ID!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          ids: batch,
          locationId,
        },
      },
    );

    const data = await response.json();

    for (const node of data.data?.nodes ?? []) {
      if (node?.id && node?.inventoryLevel?.quantities) {
        const available = node.inventoryLevel.quantities.find(
          (q: { name: string; quantity: number }) => q.name === "available",
        );
        if (available) {
          levels.set(node.id, available.quantity);
        }
      }
    }
  }

  return levels;
}

/**
 * Adjusts inventory levels for multiple items.
 */
export async function adjustInventoryLevels(
  admin: AdminApiContext,
  adjustments: InventoryAdjustment[],
  reason: string,
): Promise<void> {
  if (adjustments.length === 0) return;

  // Filter out zero-delta adjustments
  const nonZeroAdjustments = adjustments.filter((a) => a.delta !== 0);
  if (nonZeroAdjustments.length === 0) return;

  // Adjust in batches
  const batchSize = 10;
  for (let i = 0; i < nonZeroAdjustments.length; i += batchSize) {
    const batch = nonZeroAdjustments.slice(i, i + batchSize);

    const changes = batch.map((adj) => ({
      inventoryItemId: adj.inventoryItemId,
      locationId: adj.locationId,
      delta: adj.delta,
    }));

    const response = await admin.graphql(
      `#graphql
        mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            userErrors {
              field
              message
            }
            inventoryAdjustmentGroup {
              reason
              changes {
                name
                delta
                quantityAfterChange
              }
            }
          }
        }
      `,
      {
        variables: {
          input: {
            reason,
            name: "available",
            changes,
          },
        },
      },
    );

    const data = await response.json();

    // Log any errors
    if (data.data?.inventoryAdjustQuantities?.userErrors?.length > 0) {
      console.error(
        "[Sync] Inventory adjustment errors:",
        JSON.stringify(data.data.inventoryAdjustQuantities.userErrors),
      );
    }

    // Log successful changes
    const changesResult =
      data.data?.inventoryAdjustQuantities?.inventoryAdjustmentGroup?.changes;
    if (changesResult) {
      console.log(`[Sync] Applied ${changesResult.length} inventory changes`);
    }
  }
}

// ============================================================================
// Main Sync Logic
// ============================================================================

/**
 * Processes an inventory update event and syncs all related bundle variants.
 *
 * Algorithm:
 * 1. Convert inventory_item_id to variant GID
 * 2. Find all bundles containing this variant
 * 3. For each bundle:
 *    a. Acquire sync lock (skip if already processing)
 *    b. Fetch current inventory for all variants in the bundle
 *    c. Calculate new availability based on bundle type
 *    d. Adjust inventory levels to match calculated values
 *    e. Release sync lock
 */
export async function processInventoryUpdate(
  admin: AdminApiContext,
  event: InventoryUpdateEvent,
): Promise<SyncResult> {
  const { inventoryItemId, locationId, available, shop } = event;

  // Convert inventory item ID to variant GID
  // We need to find which variant has this inventory item
  const variantGid = await findVariantForInventoryItem(admin, inventoryItemId);

  if (!variantGid) {
    return {
      processed: false,
      bundlesAffected: 0,
      adjustmentsMade: 0,
      skipped: "Could not find variant for inventory item",
    };
  }

  // Find all bundles containing this variant
  const bundles = await findBundlesForVariant(shop, variantGid);

  if (bundles.length === 0) {
    return {
      processed: true,
      bundlesAffected: 0,
      adjustmentsMade: 0,
      skipped: "Variant is not part of any bundle",
    };
  }

  let totalAdjustments = 0;
  const locationGid = `gid://shopify/Location/${locationId}`;

  for (const bundle of bundles) {
    const lockId = `sync-${bundle.id}-${locationId}-${Date.now()}`;

    // Try to acquire lock
    const lockAcquired = await acquireSyncLock(lockId, bundle.id);
    if (!lockAcquired) {
      console.log(`Skipping bundle ${bundle.id} - sync already in progress`);
      continue;
    }

    try {
      const adjustments = await calculateBundleAdjustments(
        admin,
        bundle,
        locationGid,
        variantGid,
        available,
      );

      // Log the adjustments for debugging
      console.log(
        `[Sync] Bundle ${bundle.name} (${bundle.id}): ${adjustments.length} adjustments`,
      );
      for (const adj of adjustments) {
        console.log(`[Sync]   → ${adj.inventoryItemId}: delta=${adj.delta}`);
      }

      await adjustInventoryLevels(admin, adjustments, "correction");

      totalAdjustments += adjustments.length;
    } finally {
      await releaseSyncLock(lockId);
    }
  }

  return {
    processed: true,
    bundlesAffected: bundles.length,
    adjustmentsMade: totalAdjustments,
  };
}

/**
 * Finds the variant GID for a given inventory item ID.
 */
async function findVariantForInventoryItem(
  admin: AdminApiContext,
  inventoryItemId: number,
): Promise<string | null> {
  const inventoryItemGid = `gid://shopify/InventoryItem/${inventoryItemId}`;

  const response = await admin.graphql(
    `#graphql
      query getVariantFromInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          variant {
            id
          }
        }
      }
    `,
    { variables: { id: inventoryItemGid } },
  );

  const data = await response.json();
  return data.data?.inventoryItem?.variant?.id ?? null;
}

/**
 * Calculates the inventory adjustments needed for a bundle.
 */
async function calculateBundleAdjustments(
  admin: AdminApiContext,
  bundle: BundleWithChildren,
  locationGid: string,
  changedVariantGid: string,
  newAvailable: number,
): Promise<InventoryAdjustment[]> {
  const adjustments: InventoryAdjustment[] = [];

  // Collect all variant GIDs in the bundle (parent + all children)
  const allVariantGids = [
    bundle.parentGid,
    ...bundle.children.map((c) => c.childGid),
  ];
  const uniqueVariantGids = [...new Set(allVariantGids)];

  // Get inventory item IDs for all variants
  const inventoryItemMap = new Map<string, string>();
  for (const variantGid of uniqueVariantGids) {
    const inventoryItemId = await getInventoryItemForVariant(admin, variantGid);
    if (inventoryItemId) {
      inventoryItemMap.set(variantGid, inventoryItemId);
    }
  }

  // Get current inventory levels
  const inventoryItemIds = Array.from(inventoryItemMap.values());
  const currentLevels = await getInventoryLevels(
    admin,
    inventoryItemIds,
    locationGid,
  );

  // Build a map of variant GID to current stock
  const stockMap = new Map<string, number>();
  for (const [variantGid, inventoryItemId] of inventoryItemMap) {
    if (variantGid === changedVariantGid) {
      // Use the new value from the webhook for the changed variant
      stockMap.set(variantGid, newAvailable);
    } else {
      stockMap.set(variantGid, currentLevels.get(inventoryItemId) ?? 0);
    }
  }

  // Determine bundle type and calculate adjustments
  const isSameProductBundle = bundle.children.length === 1;

  if (isSameProductBundle) {
    // Same-product bundle (e.g., Single/4-Pack/24-Pack)
    // The single child with quantity represents the base unit
    const child = bundle.children[0]!;
    const baseVariantGid = child.childGid;
    const multiplier = child.quantity;

    // Get the base stock (physical units)
    const baseStock = stockMap.get(baseVariantGid) ?? 0;

    // The parent variant should have availability = floor(baseStock / multiplier)
    const expectedParentAvailability = calculateBundleAvailability(
      baseStock,
      multiplier,
    );
    const currentParentStock = stockMap.get(bundle.parentGid) ?? 0;
    const parentDelta = expectedParentAvailability - currentParentStock;

    if (parentDelta !== 0) {
      const parentInventoryItemId = inventoryItemMap.get(bundle.parentGid);
      if (parentInventoryItemId) {
        adjustments.push({
          inventoryItemId: parentInventoryItemId,
          locationId: locationGid,
          delta: parentDelta,
        });
      }
    }
  } else {
    // Mixed bundle (variety pack)
    // Calculate availability based on all children
    const components = bundle.children.map((child) => ({
      stock: stockMap.get(child.childGid) ?? 0,
      quantity: child.quantity,
    }));

    const expectedParentAvailability =
      calculateMixedBundleAvailability(components);
    const currentParentStock = stockMap.get(bundle.parentGid) ?? 0;
    const parentDelta = expectedParentAvailability - currentParentStock;

    if (parentDelta !== 0) {
      const parentInventoryItemId = inventoryItemMap.get(bundle.parentGid);
      if (parentInventoryItemId) {
        adjustments.push({
          inventoryItemId: parentInventoryItemId,
          locationId: locationGid,
          delta: parentDelta,
        });
      }
    }
  }

  return adjustments;
}
