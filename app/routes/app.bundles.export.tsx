import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Export bundles as CSV
 *
 * Format: parent_gid,parent_name,parent_sku,child_gid,child_name,quantity,expand_on_pick
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
    orderBy: { createdAt: "asc" },
  });

  // Collect all variant GIDs for title lookup (for children and parents without cached titles)
  const allGids = new Set<string>();
  for (const bundle of bundles) {
    if (!bundle.parentTitle) {
      allGids.add(bundle.parentGid);
    }
    for (const child of bundle.children) {
      allGids.add(child.childGid);
    }
  }

  // Fetch variant info from Shopify
  interface VariantInfo {
    title: string;
    sku: string;
  }
  const variantInfo: Record<string, VariantInfo> = {};

  if (allGids.size > 0) {
    try {
      interface VariantNode {
        id: string;
        title: string;
        sku: string;
        product: { title: string };
      }
      interface NodesResponse {
        nodes: Array<VariantNode | null>;
      }

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

      const data = (await response.json()) as { data?: NodesResponse };

      for (const node of data.data?.nodes ?? []) {
        if (node?.id) {
          const displayTitle =
            node.title === "Default Title"
              ? node.product.title
              : `${node.product.title} - ${node.title}`;
          variantInfo[node.id] = {
            title: displayTitle,
            sku: node.sku || "",
          };
        }
      }
    } catch {
      console.error("Failed to fetch variant titles for export");
    }
  }

  // Build CSV
  const rows: string[] = [
    // Header row - new format
    "parent_gid,parent_name,parent_sku,child_gid,child_name,quantity,expand_on_pick",
  ];

  for (const bundle of bundles) {
    const parentInfo = variantInfo[bundle.parentGid];
    const parentTitle =
      bundle.parentTitle || parentInfo?.title || bundle.parentGid;
    const parentSku = bundle.parentSku || parentInfo?.sku || "";

    for (const child of bundle.children) {
      const childInfo = variantInfo[child.childGid];
      const childTitle = childInfo?.title || child.childGid;

      // Escape CSV fields that might contain commas
      const escapeCsv = (s: string) => {
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      rows.push(
        [
          bundle.parentGid,
          escapeCsv(parentTitle),
          escapeCsv(parentSku),
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
