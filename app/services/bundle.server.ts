/**
 * Bundle utility functions for the Spicy Pickle app.
 *
 * These functions handle bundle creation logic and calculations.
 */

/**
 * Auto-detects quantity from a variant title based on common patterns.
 *
 * Looks for patterns like:
 * - "24 Pack", "24-Pack", "24-pack"
 * - "6 x 330ml", "6x330ml"
 * - "4 pk", "4pk"
 * - "Single" (returns 1)
 *
 * @param title - The variant title to parse
 * @returns The detected quantity, or null if no pattern matched
 */
export function detectQuantityFromTitle(title: string): number | null {
  if (!title) return null;

  const normalizedTitle = title.toLowerCase().trim();

  // Check for "Single" or "Individual"
  if (
    normalizedTitle === "single" ||
    normalizedTitle.includes("single") ||
    normalizedTitle === "individual"
  ) {
    return 1;
  }

  // Pattern: "24-Pack", "24 Pack", "24pack"
  const packMatch = normalizedTitle.match(/(\d+)\s*[-]?\s*pack/i);
  if (packMatch?.[1]) {
    return parseInt(packMatch[1], 10);
  }

  // Pattern: "24-pk", "24pk", "24 pk"
  const pkMatch = normalizedTitle.match(/(\d+)\s*[-]?\s*pk/i);
  if (pkMatch?.[1]) {
    return parseInt(pkMatch[1], 10);
  }

  // Pattern: "6x330ml", "6 x 330ml", "6 X 330ml"
  const xMatch = normalizedTitle.match(/(\d+)\s*x\s*\d+/i);
  if (xMatch?.[1]) {
    return parseInt(xMatch[1], 10);
  }

  // Pattern: "Case of 24", "Box of 12"
  const ofMatch = normalizedTitle.match(/(?:case|box|pack)\s+of\s+(\d+)/i);
  if (ofMatch?.[1]) {
    return parseInt(ofMatch[1], 10);
  }

  // Pattern: Just a number (e.g., "24")
  const justNumber = normalizedTitle.match(/^(\d+)$/);
  if (justNumber?.[1]) {
    return parseInt(justNumber[1], 10);
  }

  return null;
}

/**
 * Represents a bundle configuration for quick-setup.
 */
export interface QuickSetupBundle {
  parentGid: string;
  parentTitle: string;
  parentSku: string;
  baseVariantGid: string;
  quantity: number;
}

/**
 * Generates bundle configurations for a product using the quick-setup workflow.
 *
 * Given a list of variants and a designated base variant, this function
 * creates bundle configurations for all non-base variants.
 *
 * @param variants - All variants of the product
 * @param baseVariantGid - The GID of the base variant (e.g., Single)
 * @param quantities - A map of variant GID to quantity (how many base units)
 * @returns Array of bundle configurations ready to be created
 */
export function generateQuickSetupBundles(
  variants: Array<{
    gid: string;
    title: string;
    sku: string;
  }>,
  baseVariantGid: string,
  quantities: Record<string, number>,
): QuickSetupBundle[] {
  const bundles: QuickSetupBundle[] = [];

  for (const variant of variants) {
    // Skip the base variant itself
    if (variant.gid === baseVariantGid) continue;

    const quantity = quantities[variant.gid];

    // Skip variants with no quantity or quantity < 1
    if (!quantity || quantity < 1) continue;

    bundles.push({
      parentGid: variant.gid,
      parentTitle: variant.title,
      parentSku: variant.sku,
      baseVariantGid,
      quantity,
    });
  }

  return bundles;
}

/**
 * Calculates the supplier SKU quantity from Shopify variant to supplier SKU.
 *
 * This answers: "How many of this Shopify variant equals one supplier SKU?"
 *
 * For example:
 * - Supplier sells cases of 4x 6-packs (24 units)
 * - Your 6-pack variant = 0.25 supplier SKUs (4 six-packs per supplier case)
 * - Your single variant = 0.0417 supplier SKUs (24 singles per supplier case)
 *
 * @param shopifyVariantUnits - Units per Shopify variant (e.g., 6 for a 6-pack)
 * @param supplierSkuUnits - Total units per supplier SKU (e.g., 24 for a 4x6 case)
 * @returns The ratio of Shopify variant to supplier SKU
 */
export function calculateSupplierSkuRatio(
  shopifyVariantUnits: number,
  supplierSkuUnits: number,
): number {
  if (supplierSkuUnits <= 0) {
    throw new Error("Supplier SKU units must be a positive number");
  }
  if (shopifyVariantUnits <= 0) {
    throw new Error("Shopify variant units must be a positive number");
  }

  return shopifyVariantUnits / supplierSkuUnits;
}

/**
 * Calculates how many supplier SKUs are needed to fulfill a given quantity
 * of Shopify variant orders.
 *
 * @param orderQuantity - Number of Shopify variants ordered
 * @param supplierSkuQty - How many Shopify variants = 1 supplier SKU
 * @returns Number of supplier SKUs needed (always rounds up)
 */
export function calculateSupplierSkuNeeded(
  orderQuantity: number,
  supplierSkuQty: number,
): number {
  if (supplierSkuQty <= 0) {
    throw new Error("Supplier SKU quantity must be a positive number");
  }

  // How many supplier SKUs are consumed by this order?
  // Round up because you can't order partial supplier SKUs
  return Math.ceil(orderQuantity * supplierSkuQty);
}

/**
 * Calculates the total supplier SKU consumption for multiple variants.
 *
 * Useful for order reconciliation - given a list of ordered items,
 * calculate how many of each supplier SKU was consumed.
 *
 * @param orders - Array of { variantGid, quantity } for ordered items
 * @param supplierSkuMap - Map of variantGid to { supplierSku, supplierSkuQty }
 * @returns Map of supplierSku to total quantity needed
 */
export function aggregateSupplierSkuConsumption(
  orders: Array<{ variantGid: string; quantity: number }>,
  supplierSkuMap: Map<string, { supplierSku: string; supplierSkuQty: number }>,
): Map<string, number> {
  const consumption = new Map<string, number>();

  for (const order of orders) {
    const mapping = supplierSkuMap.get(order.variantGid);
    if (!mapping) continue;

    const skuConsumption = order.quantity * mapping.supplierSkuQty;
    const currentTotal = consumption.get(mapping.supplierSku) || 0;
    consumption.set(mapping.supplierSku, currentTotal + skuConsumption);
  }

  return consumption;
}
