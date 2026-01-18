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
  statuses: ("unfulfilled" | "partially_fulfilled")[];
  orderIds?: string[]; // For manual selection
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
  binLocation: string | null;
}

export interface PickListResult {
  items: PickListItem[];
  orderCount: number;
  totalItems: number;
  generatedAt: Date;
}

export type SortField = "binLocation" | "product" | "quantity";
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
  sortBy: SortField = "binLocation",
  sortDirection: SortDirection = "asc",
): Promise<PickListResult> {
  // Fetch orders matching filters
  const orders = await fetchOrders(admin, filters);

  // Collect all line items
  const lineItems: OrderLineItem[] = [];
  for (const order of orders) {
    lineItems.push(...order.lineItems);
  }

  // Expand bundles where expandOnPick is true
  const expandedItems = await expandBundles(admin, filters.shop, lineItems);

  // Aggregate by variant
  const aggregated = aggregateItems(expandedItems);

  // Add bin locations
  const itemsWithLocations = await addBinLocations(filters.shop, aggregated);

  // Sort items
  const sortedItems = sortItems(itemsWithLocations, sortBy, sortDirection);

  return {
    items: sortedItems,
    orderCount: orders.length,
    totalItems: sortedItems.reduce((sum, item) => sum + item.quantity, 0),
    generatedAt: new Date(),
  };
}

/**
 * Fetches orders matching the given filters from Shopify.
 */
async function fetchOrders(
  admin: AdminApiContext,
  filters: PickListFilters,
): Promise<Array<{ id: string; name: string; lineItems: OrderLineItem[] }>> {
  const orders: Array<{
    id: string;
    name: string;
    lineItems: OrderLineItem[];
  }> = [];

  // Build query string
  const queryParts: string[] = [];

  if (filters.statuses.includes("unfulfilled")) {
    queryParts.push("fulfillment_status:unfulfilled");
  }
  if (filters.statuses.includes("partially_fulfilled")) {
    queryParts.push("fulfillment_status:partial");
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
      // If specific order IDs are provided, filter
      if (filters.orderIds && !filters.orderIds.includes(order.id)) {
        continue;
      }

      const lineItems: OrderLineItem[] = [];

      for (const lineItem of order.lineItems?.nodes ?? []) {
        if (!lineItem.variant) continue;

        lineItems.push({
          variantGid: lineItem.variant.id,
          productTitle: lineItem.variant.product?.title ?? "Unknown Product",
          variantTitle: lineItem.variant.title ?? "Default",
          sku: lineItem.variant.sku ?? null,
          quantity: lineItem.quantity,
        });
      }

      orders.push({
        id: order.id,
        name: order.name,
        lineItems,
      });
    }

    hasNextPage = ordersData.pageInfo?.hasNextPage ?? false;
    cursor = ordersData.pageInfo?.endCursor ?? null;
  }

  return orders;
}

/**
 * Expands bundles with expandOnPick=true to their component variants.
 */
async function expandBundles(
  admin: AdminApiContext,
  shop: string,
  lineItems: OrderLineItem[],
): Promise<OrderLineItem[]> {
  const result: OrderLineItem[] = [];

  // Get all variant GIDs
  const variantGids = [...new Set(lineItems.map((item) => item.variantGid))];

  // Find bundles where these variants are the parent and expandOnPick is true
  const expandableBundles = await db.bundle.findMany({
    where: {
      shopId: shop,
      parentGid: { in: variantGids },
      expandOnPick: true,
    },
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
 * Adds bin locations to aggregated items.
 */
async function addBinLocations(
  shop: string,
  items: OrderLineItem[],
): Promise<PickListItem[]> {
  const variantGids = items.map((item) => item.variantGid);

  const locations = await db.binLocation.findMany({
    where: {
      shopId: shop,
      variantGid: { in: variantGids },
    },
  });

  const locationMap = new Map(locations.map((l) => [l.variantGid, l.location]));

  return items.map((item) => ({
    ...item,
    binLocation: locationMap.get(item.variantGid) ?? null,
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
      case "binLocation": {
        // Null bin locations go to the end
        if (!a.binLocation && !b.binLocation) return 0;
        if (!a.binLocation) return 1;
        if (!b.binLocation) return -1;
        return multiplier * a.binLocation.localeCompare(b.binLocation);
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
  const headers = ["Product", "Variant", "SKU", "Quantity", "Bin Location"];
  const rows = items.map((item) => [
    escapeCSV(item.productTitle),
    escapeCSV(item.variantTitle),
    escapeCSV(item.sku ?? ""),
    String(item.quantity),
    escapeCSV(item.binLocation ?? ""),
  ]);

  return [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
