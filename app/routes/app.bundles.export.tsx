import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Export bundles as CSV
 *
 * Format: name,parent_gid,child_gid,quantity,expand_on_pick
 *
 * Each bundle-child relationship is a separate row.
 * Multiple rows with the same parent_gid represent one bundle with multiple children.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Fetch all bundles with children
  const bundles = await db.bundle.findMany({
    where: { shopId: shop },
    include: { children: true },
    orderBy: { name: "asc" },
  });

  // Collect all variant GIDs for title lookup
  const allGids = new Set<string>();
  for (const bundle of bundles) {
    allGids.add(bundle.parentGid);
    for (const child of bundle.children) {
      allGids.add(child.childGid);
    }
  }

  // Fetch variant titles from Shopify
  const variantTitles: Record<string, string> = {};

  if (allGids.size > 0) {
    try {
      const response = await admin.graphql(
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
        { variables: { ids: Array.from(allGids) } },
      );

      const data = await response.json();

      for (const node of data.data?.nodes ?? []) {
        if (node?.id) {
          const sku = node.sku ? ` (${node.sku})` : "";
          variantTitles[node.id] =
            `${node.product?.title ?? "Unknown"} - ${node.title}${sku}`;
        }
      }
    } catch {
      console.error("Failed to fetch variant titles for export");
    }
  }

  // Build CSV
  const rows: string[] = [
    // Header row
    "name,parent_gid,parent_title,child_gid,child_title,quantity,expand_on_pick",
  ];

  for (const bundle of bundles) {
    const parentTitle = variantTitles[bundle.parentGid] ?? "";

    for (const child of bundle.children) {
      const childTitle = variantTitles[child.childGid] ?? "";

      // Escape CSV fields that might contain commas
      const escapeCsv = (s: string) => {
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      rows.push(
        [
          escapeCsv(bundle.name),
          bundle.parentGid,
          escapeCsv(parentTitle),
          child.childGid,
          escapeCsv(childTitle),
          String(child.quantity),
          String(bundle.expandOnPick),
        ].join(","),
      );
    }
  }

  const csvContent = rows.join("\n");
  const timestamp = new Date().toISOString().slice(0, 10);

  return new Response(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="bundles-${shop}-${timestamp}.csv"`,
    },
  });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
