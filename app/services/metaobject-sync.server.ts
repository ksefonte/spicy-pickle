/**
 * Metaobject Sync Service
 *
 * Keeps Prisma Bundle/BundleChild rows in sync with Shopify
 * `product_relationship` metaobjects. The sync reads all variants that have
 * `custom.product_relationships` populated, resolves the referenced
 * metaobjects, and upserts the corresponding Prisma rows.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getMetaobjectFieldMap } from "./metaobject-setup.server";
import prisma from "../db.server";

const SYNC_STALE_MS = 5 * 60 * 1000; // 5 minutes

const ATTACHMENT_NAMESPACE = "custom";
const ATTACHMENT_KEY = "product_relationships";
const METAOBJECT_TYPE = "product_relationship";

// ============================================================================
// Public API
// ============================================================================

/**
 * Runs a full sync if the last sync is older than SYNC_STALE_MS.
 * Returns true if a sync was performed, false if skipped (still fresh).
 */
export async function syncIfStale(
  admin: AdminApiContext,
  shopId: string,
): Promise<boolean> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { lastMetaobjectSyncAt: true },
  });

  if (shop?.lastMetaobjectSyncAt) {
    const age = Date.now() - shop.lastMetaobjectSyncAt.getTime();
    if (age < SYNC_STALE_MS) {
      return false;
    }
  }

  await syncMetaobjectsToPrisma(admin, shopId);
  return true;
}

/**
 * Full sync: queries all product_relationship metaobjects from Shopify,
 * resolves which variants reference them, and upserts Bundle/BundleChild
 * rows in Prisma. Deletes orphaned Prisma bundles.
 */
export async function syncMetaobjectsToPrisma(
  admin: AdminApiContext,
  shopId: string,
): Promise<SyncStats> {
  const fieldMap = await getMetaobjectFieldMap(admin);
  const stats: SyncStats = { created: 0, updated: 0, deleted: 0, total: 0 };

  // Step 1: Fetch all variants that have product_relationships attached
  const variantRelationships = await fetchAllVariantRelationships(
    admin,
    fieldMap,
  );
  stats.total = variantRelationships.length;

  // Step 2: Ensure shop exists
  await prisma.shop.upsert({
    where: { id: shopId },
    update: {},
    create: { id: shopId },
  });

  // Step 3: Collect all parentGids we're about to upsert
  const activeParentGids = new Set<string>();

  for (const rel of variantRelationships) {
    activeParentGids.add(rel.parentVariantGid);

    const existing = await prisma.bundle.findUnique({
      where: {
        shopId_parentGid: { shopId, parentGid: rel.parentVariantGid },
      },
    });

    await prisma.bundle.upsert({
      where: {
        shopId_parentGid: { shopId, parentGid: rel.parentVariantGid },
      },
      update: {
        parentTitle: rel.parentTitle,
        parentSku: rel.parentSku,
        children: {
          deleteMany: {},
          create: rel.children.map((c) => ({
            childGid: c.childGid,
            quantity: c.quantity,
          })),
        },
      },
      create: {
        shopId,
        parentGid: rel.parentVariantGid,
        parentTitle: rel.parentTitle,
        parentSku: rel.parentSku,
        children: {
          create: rel.children.map((c) => ({
            childGid: c.childGid,
            quantity: c.quantity,
          })),
        },
      },
    });

    if (existing) {
      stats.updated++;
    } else {
      stats.created++;
    }
  }

  // Step 4: Delete Prisma bundles that no longer exist as metaobjects
  const orphanedBundles = await prisma.bundle.findMany({
    where: {
      shopId,
      parentGid: { notIn: Array.from(activeParentGids) },
    },
    select: { id: true },
  });

  if (orphanedBundles.length > 0) {
    await prisma.bundle.deleteMany({
      where: {
        id: { in: orphanedBundles.map((b) => b.id) },
      },
    });
    stats.deleted = orphanedBundles.length;
  }

  // Step 5: Update sync timestamp
  await prisma.shop.update({
    where: { id: shopId },
    data: { lastMetaobjectSyncAt: new Date() },
  });

  console.log(
    `[Sync] Metaobject → Prisma complete for ${shopId}: ` +
      `${stats.created} created, ${stats.updated} updated, ${stats.deleted} deleted ` +
      `(${stats.total} variant relationships found)`,
  );

  return stats;
}

// ============================================================================
// Types
// ============================================================================

export interface SyncStats {
  created: number;
  updated: number;
  deleted: number;
  total: number;
}

interface VariantRelationship {
  parentVariantGid: string;
  parentTitle: string | null;
  parentSku: string | null;
  children: Array<{
    childGid: string;
    quantity: number;
  }>;
}

interface MetaobjectFieldMapResult {
  childKey: string;
  quantityKey: string;
}

// ============================================================================
// Internal: Fetch all variant relationships from Shopify
// ============================================================================

/**
 * Queries all products/variants that have `custom.product_relationships`
 * populated, resolves each referenced metaobject to get child + quantity,
 * and returns a flat list of parent→children mappings.
 */
async function fetchAllVariantRelationships(
  admin: AdminApiContext,
  fieldMap: MetaobjectFieldMapResult,
): Promise<VariantRelationship[]> {
  const relationships: VariantRelationship[] = [];

  // First, get all metaobjects of type product_relationship to build a lookup
  const metaobjectLookup = await fetchAllMetaobjects(admin, fieldMap);

  // Then scan variants that have the attachment metafield
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query GetVariantsWithRelationships(
          $first: Int!
          $after: String
          $ns: String!
          $key: String!
        ) {
          productVariants(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              sku
              product {
                title
              }
              metafield(namespace: $ns, key: $key) {
                value
              }
            }
          }
        }
      `,
      {
        variables: {
          first: 50,
          after: cursor,
          ns: ATTACHMENT_NAMESPACE,
          key: ATTACHMENT_KEY,
        },
      },
    );

    const data = (await response.json()) as {
      data?: {
        productVariants?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            title: string;
            sku: string | null;
            product: { title: string };
            metafield: { value: string } | null;
          }>;
        };
      };
    };

    const variants = data.data?.productVariants;
    if (!variants) break;

    for (const variant of variants.nodes) {
      if (!variant.metafield?.value) continue;

      let metaobjectGids: string[];
      try {
        metaobjectGids = JSON.parse(variant.metafield.value) as string[];
      } catch {
        continue;
      }

      if (!Array.isArray(metaobjectGids) || metaobjectGids.length === 0)
        continue;

      const children: Array<{ childGid: string; quantity: number }> = [];
      for (const gid of metaobjectGids) {
        const mo = metaobjectLookup.get(gid);
        if (mo) {
          children.push(mo);
        }
      }

      if (children.length > 0) {
        relationships.push({
          parentVariantGid: variant.id,
          parentTitle: `${variant.product.title} - ${variant.title}`,
          parentSku: variant.sku,
          children,
        });
      }
    }

    hasNextPage = variants.pageInfo.hasNextPage;
    cursor = variants.pageInfo.endCursor;
  }

  return relationships;
}

/**
 * Fetches all product_relationship metaobjects and returns a Map
 * from metaobject GID to { childGid, quantity }.
 */
async function fetchAllMetaobjects(
  admin: AdminApiContext,
  fieldMap: MetaobjectFieldMapResult,
): Promise<Map<string, { childGid: string; quantity: number }>> {
  const lookup = new Map<string, { childGid: string; quantity: number }>();

  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query GetProductRelationships(
          $type: String!
          $first: Int!
          $after: String
        ) {
          metaobjects(type: $type, first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              fields {
                key
                value
              }
            }
          }
        }
      `,
      {
        variables: {
          type: METAOBJECT_TYPE,
          first: 50,
          after: cursor,
        },
      },
    );

    const data = (await response.json()) as {
      data?: {
        metaobjects?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            fields: Array<{ key: string; value: string }>;
          }>;
        };
      };
    };

    const metaobjects = data.data?.metaobjects;
    if (!metaobjects) break;

    for (const mo of metaobjects.nodes) {
      const childField = mo.fields.find((f) => f.key === fieldMap.childKey);
      const quantityField = mo.fields.find(
        (f) => f.key === fieldMap.quantityKey,
      );

      if (childField?.value && quantityField?.value) {
        lookup.set(mo.id, {
          childGid: childField.value,
          quantity: parseInt(quantityField.value, 10) || 1,
        });
      }
    }

    hasNextPage = metaobjects.pageInfo.hasNextPage;
    cursor = metaobjects.pageInfo.endCursor;
  }

  return lookup;
}
