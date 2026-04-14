/**
 * Pick List Service
 *
 * Generates consolidated picking lists from Shopify orders.
 * Aggregates line items across orders, optionally expands bundles to their
 * components, and includes bin locations for efficient warehouse picking.
 */

import db from "../db.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// ============================================================================
// Types
// ============================================================================

export interface PickListFilters {
  shop: string;
  startDate?: Date;
  endDate?: Date;
  statuses: ("unfulfilled" | "partially_fulfilled" | "fulfilled")[];
  orderIds?: string[]; // For manual selection
  requiresShipping?: boolean;
}

export interface OrderLineItem {
  variantGid: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
}

export interface PickListItem {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  variantGid: string;
  quantity: number;
  binName: string | null;
  binSortOrder: number;
  available: number | null;
}

export interface OrderSummary {
  name: string;
  lineItems: Array<{
    quantity: number;
    description: string;
  }>;
}

export type PickListMode = "resolved" | "no-expand" | "configured";

export interface PickListResult {
  items: PickListItem[];
  orderCount: number;
  totalItems: number;
  generatedAt: Date;
  orders: OrderSummary[];
  mode: PickListMode;
}

export type SortField = "bin" | "product" | "quantity";
export type SortDirection = "asc" | "desc";

// GraphQL response types
interface OrdersQueryResult {
  pageInfo?: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes?: Array<{
    id: string;
    name: string;
    lineItems?: {
      nodes?: Array<{
        quantity: number;
        requiresShipping: boolean;
        variant?: {
          id: string;
          title: string;
          sku: string | null;
          product?: {
            title: string;
          };
        };
      }>;
    };
  }>;
}

interface VariantsQueryResult {
  nodes?: Array<{
    id?: string;
    title?: string;
    sku?: string | null;
    product?: {
      title?: string;
    };
  }>;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Generates a pick list from orders matching the given filters.
 *
 * Algorithm:
 * 1. Fetch orders with line items via GraphQL
 * 2. For each line item:
 *    - Check if variant has bundle with expandOnPick=true
 *    - If yes, replace with (child variants × child quantities × line item quantity)
 *    - If no, keep as-is
 * 3. Aggregate all variants, sum quantities
 * 4. Join with bin locations from database
 * 5. Return sorted by bin location for efficient warehouse picking
 */
export async function generatePickList(
  admin: AdminApiContext,
  filters: PickListFilters,
  sortBy: SortField = "bin",
  sortDirection: SortDirection = "asc",
  mode: PickListMode = "resolved",
): Promise<PickListResult> {
  const { orders, lineItems, orderSummaries } = await fetchOrdersWithSummaries(
    admin,
    filters,
  );
  const expandedItems = await expandBundles(
    admin,
    filters.shop,
    lineItems,
    mode,
  );
  const aggregated = aggregateItems(expandedItems);
  const itemsWithBins = await addBinInfo(filters.shop, aggregated);
  const itemsWithInventory = await addInventoryLevels(admin, itemsWithBins);
  const sortedItems = sortItems(itemsWithInventory, sortBy, sortDirection);
  return {
    items: sortedItems,
    orderCount: orders.length,
    totalItems: sortedItems.reduce((sum, item) => sum + item.quantity, 0),
    generatedAt: new Date(),
    orders: orderSummaries,
    mode,
  };
}

/**
 * Fetches orders matching the given filters from Shopify and builds order summaries.
 */
async function fetchOrdersWithSummaries(
  admin: AdminApiContext,
  filters: PickListFilters,
): Promise<{
  orders: Array<{ id: string; name: string; lineItems: OrderLineItem[] }>;
  lineItems: OrderLineItem[];
  orderSummaries: OrderSummary[];
}> {
  const orders: Array<{
    id: string;
    name: string;
    lineItems: OrderLineItem[];
  }> = [];
  const orderSummaries: OrderSummary[] = [];

  const queryParts: string[] = [];

  const statusParts: string[] = [];
  if (filters.statuses.includes("unfulfilled")) {
    statusParts.push("fulfillment_status:unfulfilled");
  }
  if (filters.statuses.includes("partially_fulfilled")) {
    statusParts.push("fulfillment_status:partial");
  }
  if (filters.statuses.includes("fulfilled")) {
    statusParts.push("fulfillment_status:shipped");
  }
  if (statusParts.length > 0) {
    queryParts.push(`(${statusParts.join(" OR ")})`);
  }

  if (filters.startDate) {
    queryParts.push(`created_at:>=${filters.startDate.toISOString()}`);
  }
  if (filters.endDate) {
    queryParts.push(`created_at:<=${filters.endDate.toISOString()}`);
  }

  const queryString =
    queryParts.length > 0
      ? queryParts.join(" AND ")
      : "fulfillment_status:unfulfilled";

  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response: Response = await admin.graphql(
      `#graphql
        query getOrders($first: Int!, $after: String, $query: String!) {
          orders(first: $first, after: $after, query: $query) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              name
              lineItems(first: 100) {
                nodes {
                  quantity
                  requiresShipping
                  variant {
                    id
                    title
                    sku
                    product {
                      title
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        variables: {
          first: 50,
          after: cursor,
          query: queryString,
        },
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data: { data?: { orders?: OrdersQueryResult } } =
      await response.json();
    const ordersData: OrdersQueryResult | undefined = data.data?.orders;

    if (!ordersData) break;

    for (const order of ordersData.nodes ?? []) {
      if (filters.orderIds && !filters.orderIds.includes(order.id)) {
        continue;
      }

      const lineItems: OrderLineItem[] = [];
      const summaryLineItems: OrderSummary["lineItems"] = [];

      for (const lineItem of order.lineItems?.nodes ?? []) {
        if (!lineItem.variant) continue;

        if (
          filters.requiresShipping !== undefined &&
          lineItem.requiresShipping !== filters.requiresShipping
        ) {
          continue;
        }

        const productTitle =
          lineItem.variant.product?.title ?? "Unknown Product";
        const variantTitle = lineItem.variant.title ?? "Default";
        const sku = lineItem.variant.sku ?? null;

        lineItems.push({
          variantGid: lineItem.variant.id,
          productTitle,
          variantTitle,
          sku,
          quantity: lineItem.quantity,
        });

        const skuSuffix = sku ? ` (${sku})` : "";
        summaryLineItems.push({
          quantity: lineItem.quantity,
          description: `${productTitle} - ${variantTitle}${skuSuffix}`,
        });
      }

      if (lineItems.length > 0) {
        orders.push({
          id: order.id,
          name: order.name,
          lineItems,
        });
        orderSummaries.push({
          name: order.name,
          lineItems: summaryLineItems,
        });
      }
    }

    hasNextPage = ordersData.pageInfo?.hasNextPage ?? false;
    cursor = ordersData.pageInfo?.endCursor ?? null;
  }

  const allLineItems: OrderLineItem[] = [];
  for (const order of orders) {
    allLineItems.push(...order.lineItems);
  }

  return { orders, lineItems: allLineItems, orderSummaries };
}

/**
 * Expands bundles to their component variants.
 * - "resolved": All bundles with children are expanded.
 * - "no-expand": No expansion; every variant appears as ordered.
 * - "configured": Only bundles with expandOnPick=true are expanded.
 */
async function expandBundles(
  admin: AdminApiContext,
  shop: string,
  lineItems: OrderLineItem[],
  mode: PickListMode = "resolved",
): Promise<OrderLineItem[]> {
  if (mode === "no-expand") return lineItems;

  const result: OrderLineItem[] = [];

  const variantGids = [...new Set(lineItems.map((item) => item.variantGid))];

  const whereClause =
    mode === "resolved"
      ? { shopId: shop, parentGid: { in: variantGids } }
      : { shopId: shop, parentGid: { in: variantGids }, expandOnPick: true };

  const expandableBundles = await db.bundle.findMany({
    where: whereClause,
    include: {
      children: true,
    },
  });

  // Create a map for quick lookup
  const bundleMap = new Map(expandableBundles.map((b) => [b.parentGid, b]));

  // Get variant info for bundle children
  const childGids = expandableBundles.flatMap((b) =>
    b.children.map((c) => c.childGid),
  );
  const childVariantInfo = await fetchVariantInfo(admin, childGids);

  for (const item of lineItems) {
    const bundle = bundleMap.get(item.variantGid);

    if (bundle) {
      // Expand to children
      for (const child of bundle.children) {
        const childInfo = childVariantInfo.get(child.childGid);
        result.push({
          variantGid: child.childGid,
          productTitle: childInfo?.productTitle ?? "Unknown Product",
          variantTitle: childInfo?.variantTitle ?? "Unknown Variant",
          sku: childInfo?.sku ?? null,
          quantity: item.quantity * child.quantity,
        });
      }
    } else {
      // Keep as-is
      result.push(item);
    }
  }

  return result;
}

/**
 * Fetches variant info for multiple variant GIDs.
 */
async function fetchVariantInfo(
  admin: AdminApiContext,
  variantGids: string[],
): Promise<
  Map<
    string,
    { productTitle: string; variantTitle: string; sku: string | null }
  >
> {
  const result = new Map<
    string,
    { productTitle: string; variantTitle: string; sku: string | null }
  >();

  if (variantGids.length === 0) return result;

  // Fetch in batches
  const batchSize = 50;
  for (let i = 0; i < variantGids.length; i += batchSize) {
    const batch = variantGids.slice(i, i + batchSize);

    const response: Response = await admin.graphql(
      `#graphql
        query getVariants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              title
              sku
              product {
                title
              }
            }
          }
        }
      `,
      { variables: { ids: batch } },
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data: { data?: VariantsQueryResult } = await response.json();

    for (const node of data.data?.nodes ?? []) {
      if (node?.id) {
        result.set(node.id, {
          productTitle: node.product?.title ?? "Unknown Product",
          variantTitle: node.title ?? "Default",
          sku: node.sku ?? null,
        });
      }
    }
  }

  return result;
}

/**
 * Aggregates line items by variant, summing quantities.
 */
export function aggregateItems(items: OrderLineItem[]): OrderLineItem[] {
  const aggregated = new Map<string, OrderLineItem>();

  for (const item of items) {
    const existing = aggregated.get(item.variantGid);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      aggregated.set(item.variantGid, { ...item });
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Adds bin name and sort order to aggregated items via BinVariant → Bin.
 */
async function addBinInfo(
  shop: string,
  items: OrderLineItem[],
): Promise<PickListItem[]> {
  const variantGids = items.map((item) => item.variantGid);

  const binVariants = await db.binVariant.findMany({
    where: {
      shopId: shop,
      variantGid: { in: variantGids },
    },
    include: { bin: true },
  });

  const binMap = new Map(
    binVariants.map((bv) => [
      bv.variantGid,
      { name: bv.bin.name, sortOrder: bv.bin.sortOrder },
    ]),
  );

  return items.map((item) => {
    const bin = binMap.get(item.variantGid);
    return {
      ...item,
      binName: bin?.name ?? null,
      binSortOrder: bin?.sortOrder ?? Number.MAX_SAFE_INTEGER,
      available: null,
    };
  });
}

/**
 * Fetches available inventory for all variant GIDs via the Admin API.
 */
async function addInventoryLevels(
  admin: AdminApiContext,
  items: PickListItem[],
): Promise<PickListItem[]> {
  const variantGids = items.map((i) => i.variantGid);
  if (variantGids.length === 0) return items;

  const batchSize = 250;
  const levelMap = new Map<string, number>();

  for (let i = 0; i < variantGids.length; i += batchSize) {
    const batch = variantGids.slice(i, i + batchSize);
    const response: Response = await admin.graphql(
      `#graphql
        query getVariantInventory($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              inventoryQuantity
            }
          }
        }
      `,
      { variables: { ids: batch } },
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data: {
      data?: { nodes?: Array<{ id?: string; inventoryQuantity?: number }> };
    } = await response.json();
    for (const node of data.data?.nodes ?? []) {
      if (node?.id != null && node?.inventoryQuantity != null) {
        levelMap.set(node.id, node.inventoryQuantity);
      }
    }
  }

  return items.map((item) => ({
    ...item,
    available: levelMap.get(item.variantGid) ?? null,
  }));
}

/**
 * Sorts pick list items.
 */
export function sortItems(
  items: PickListItem[],
  sortBy: SortField,
  direction: SortDirection,
): PickListItem[] {
  const multiplier = direction === "asc" ? 1 : -1;

  return [...items].sort((a, b) => {
    switch (sortBy) {
      case "bin": {
        const aHasBin = a.binName != null;
        const bHasBin = b.binName != null;
        if (!aHasBin && !bHasBin) return 0;
        if (!aHasBin) return 1;
        if (!bHasBin) return -1;
        const orderDiff = a.binSortOrder - b.binSortOrder;
        if (orderDiff !== 0) return multiplier * orderDiff;
        return multiplier * a.productTitle.localeCompare(b.productTitle);
      }
      case "product": {
        const productCompare = a.productTitle.localeCompare(b.productTitle);
        if (productCompare !== 0) return multiplier * productCompare;
        return multiplier * a.variantTitle.localeCompare(b.variantTitle);
      }
      case "quantity": {
        return multiplier * (a.quantity - b.quantity);
      }
      default:
        return 0;
    }
  });
}

/**
 * Exports pick list to CSV format.
 */
export function exportToCSV(items: PickListItem[]): string {
  const headers = ["Product", "Variant", "SKU", "Available", "Quantity", "Bin"];
  const rows = items.map((item) => [
    escapeCSV(item.productTitle),
    escapeCSV(item.variantTitle),
    escapeCSV(item.sku ?? ""),
    item.available != null ? String(item.available) : "",
    String(item.quantity),
    escapeCSV(item.binName ?? ""),
  ]);

  return [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
