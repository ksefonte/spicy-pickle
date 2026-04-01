/**
 * Metaobject Write Service
 *
 * Shared service for creating, updating, and deleting product_relationship
 * metaobjects and their attachment to variants via custom.product_relationships.
 * Used by all bundle CRUD routes and the migration page.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getMetaobjectFieldMap } from "./metaobject-setup.server";
import prisma from "../db.server";

const METAOBJECT_TYPE = "product_relationship";
const ATTACHMENT_NAMESPACE = "custom";
const ATTACHMENT_KEY = "product_relationships";

// ============================================================================
// Public API
// ============================================================================

export interface BundleChild {
  childGid: string;
  quantity: number;
}

/**
 * Creates a full bundle as metaobjects + attaches to variant + syncs Prisma.
 * Returns the created Prisma bundle ID.
 */
export async function createBundleAsMetaobjects(
  admin: AdminApiContext,
  shopId: string,
  parentVariantGid: string,
  children: BundleChild[],
  options?: {
    parentTitle?: string | null;
    parentSku?: string | null;
    expandOnPick?: boolean;
  },
): Promise<string> {
  const metaobjectGids: string[] = [];

  for (const child of children) {
    const gid = await createProductRelationship(
      admin,
      child.childGid,
      child.quantity,
    );
    metaobjectGids.push(gid);
  }

  await setVariantRelationships(admin, parentVariantGid, metaobjectGids);

  const bundle = await upsertPrismaBundle(
    shopId,
    parentVariantGid,
    children,
    options,
  );
  return bundle.id;
}

/**
 * Updates an existing bundle: replaces metaobjects + re-attaches + syncs Prisma.
 */
export async function updateBundleMetaobjects(
  admin: AdminApiContext,
  shopId: string,
  parentVariantGid: string,
  children: BundleChild[],
  options?: {
    parentTitle?: string | null;
    parentSku?: string | null;
    expandOnPick?: boolean;
  },
): Promise<void> {
  // Delete existing metaobjects for this variant
  await deleteVariantMetaobjects(admin, parentVariantGid);

  // Create new ones
  const metaobjectGids: string[] = [];
  for (const child of children) {
    const gid = await createProductRelationship(
      admin,
      child.childGid,
      child.quantity,
    );
    metaobjectGids.push(gid);
  }

  await setVariantRelationships(admin, parentVariantGid, metaobjectGids);
  await upsertPrismaBundle(shopId, parentVariantGid, children, options);
}

/**
 * Deletes all metaobjects for a variant and removes the Prisma bundle.
 */
export async function deleteBundleMetaobjects(
  admin: AdminApiContext,
  shopId: string,
  parentVariantGid: string,
): Promise<void> {
  await deleteVariantMetaobjects(admin, parentVariantGid);

  await prisma.bundle.deleteMany({
    where: { shopId, parentGid: parentVariantGid },
  });
}

// ============================================================================
// Metaobject CRUD
// ============================================================================

async function createProductRelationship(
  admin: AdminApiContext,
  childVariantGid: string,
  quantity: number,
): Promise<string> {
  const fieldMap = await getMetaobjectFieldMap(admin);

  const response = await admin.graphql(
    `#graphql
      mutation CreateProductRelationship($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        metaobject: {
          type: METAOBJECT_TYPE,
          fields: [
            { key: fieldMap.childKey, value: childVariantGid },
            { key: fieldMap.quantityKey, value: String(quantity) },
          ],
        },
      },
    },
  );

  const data = (await response.json()) as {
    data?: {
      metaobjectCreate?: {
        metaobject?: { id: string };
        userErrors?: Array<{ field: string[]; message: string }>;
      };
    };
  };

  const errors = data.data?.metaobjectCreate?.userErrors;
  if (errors && errors.length > 0) {
    throw new Error(`Metaobject create error: ${JSON.stringify(errors)}`);
  }

  const id = data.data?.metaobjectCreate?.metaobject?.id;
  if (!id) {
    throw new Error("Metaobject created but no ID returned");
  }

  return id;
}

// ============================================================================
// Single-relationship operations (used by the in-app relationship editor)
// ============================================================================

/**
 * Adds a single product_relationship to a variant (appends to existing list).
 * If a metaobject already exists with the same child, it is updated in-place
 * rather than creating a duplicate.
 */
export async function addSingleRelationship(
  admin: AdminApiContext,
  variantGid: string,
  childGid: string,
  quantity: number,
): Promise<string> {
  const existing = await getExistingAttachments(admin, variantGid);

  const match = await findExistingMetaobjectForChild(admin, existing, childGid);
  if (match) {
    await updateMetaobjectQuantity(admin, match, quantity);
    return match;
  }

  const metaobjectGid = await createProductRelationship(
    admin,
    childGid,
    quantity,
  );
  await setVariantRelationships(admin, variantGid, [
    ...existing,
    metaobjectGid,
  ]);
  return metaobjectGid;
}

/**
 * Removes a single product_relationship from a variant and deletes the metaobject.
 */
export async function removeSingleRelationship(
  admin: AdminApiContext,
  variantGid: string,
  metaobjectGid: string,
): Promise<void> {
  const existing = await getExistingAttachments(admin, variantGid);
  await setVariantRelationships(
    admin,
    variantGid,
    existing.filter((g) => g !== metaobjectGid),
  );

  try {
    await admin.graphql(
      `#graphql
        mutation DeleteMetaobject($id: ID!) {
          metaobjectDelete(id: $id) {
            deletedId
            userErrors { field message }
          }
        }
      `,
      { variables: { id: metaobjectGid } },
    );
  } catch {
    // Best-effort: metaobject may already be deleted
  }
}

/**
 * Re-writes all metafield attachment values for a product's variants.
 * Fixes the issue where data written before the definition existed
 * doesn't show in the Shopify admin UI.
 */
export async function reattachProductRelationships(
  admin: AdminApiContext,
  productGid: string,
): Promise<number> {
  const response = await admin.graphql(
    `#graphql
      query GetVariantAttachments($id: ID!, $ns: String!, $key: String!) {
        product(id: $id) {
          variants(first: 100) {
            nodes {
              id
              metafield(namespace: $ns, key: $key) {
                value
              }
            }
          }
        }
      }
    `,
    {
      variables: {
        id: productGid,
        ns: ATTACHMENT_NAMESPACE,
        key: ATTACHMENT_KEY,
      },
    },
  );

  const data = (await response.json()) as {
    data?: {
      product?: {
        variants: {
          nodes: Array<{
            id: string;
            metafield: { value: string } | null;
          }>;
        };
      };
    };
  };

  let fixed = 0;
  for (const v of data.data?.product?.variants.nodes ?? []) {
    if (!v.metafield?.value) continue;
    try {
      const gids = JSON.parse(v.metafield.value) as string[];
      if (!Array.isArray(gids) || gids.length === 0) continue;
      await setVariantRelationships(admin, v.id, gids);
      fixed++;
    } catch {
      // skip unparseable values
    }
  }
  return fixed;
}

// ============================================================================
// Attachment (variant ↔ metaobject list)
// ============================================================================

async function getExistingAttachments(
  admin: AdminApiContext,
  variantGid: string,
): Promise<string[]> {
  const response = await admin.graphql(
    `#graphql
      query GetExistingRelationships($id: ID!, $ns: String!, $key: String!) {
        productVariant(id: $id) {
          metafield(namespace: $ns, key: $key) {
            value
          }
        }
      }
    `,
    {
      variables: {
        id: variantGid,
        ns: ATTACHMENT_NAMESPACE,
        key: ATTACHMENT_KEY,
      },
    },
  );

  const data = (await response.json()) as {
    data?: {
      productVariant?: {
        metafield?: { value: string } | null;
      };
    };
  };

  const value = data.data?.productVariant?.metafield?.value;
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function setVariantRelationships(
  admin: AdminApiContext,
  variantGid: string,
  metaobjectGids: string[],
): Promise<void> {
  const response = await admin.graphql(
    `#graphql
      mutation SetVariantRelationships($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            namespace: ATTACHMENT_NAMESPACE,
            key: ATTACHMENT_KEY,
            ownerId: variantGid,
            type: "list.metaobject_reference",
            value: JSON.stringify(metaobjectGids),
          },
        ],
      },
    },
  );

  const data = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        userErrors?: Array<{ field: string; message: string }>;
      };
    };
  };

  const errors = data.data?.metafieldsSet?.userErrors;
  if (errors && errors.length > 0) {
    throw new Error(`Metafield attach error: ${JSON.stringify(errors)}`);
  }
}

/**
 * Deletes all product_relationship metaobjects attached to a variant
 * and clears the attachment metafield.
 */
async function deleteVariantMetaobjects(
  admin: AdminApiContext,
  variantGid: string,
): Promise<void> {
  const existingGids = await getExistingAttachments(admin, variantGid);

  // Delete each metaobject
  for (const gid of existingGids) {
    try {
      await admin.graphql(
        `#graphql
          mutation DeleteMetaobject($id: ID!) {
            metaobjectDelete(id: $id) {
              deletedId
              userErrors {
                field
                message
              }
            }
          }
        `,
        { variables: { id: gid } },
      );
    } catch {
      // Best-effort: metaobject may already be deleted
    }
  }

  // Clear the attachment metafield
  if (existingGids.length > 0) {
    await setVariantRelationships(admin, variantGid, []);
  }
}

/**
 * Resolves a list of metaobject GIDs to find one whose child field matches
 * the given childGid. Returns the metaobject GID if found, null otherwise.
 */
async function findExistingMetaobjectForChild(
  admin: AdminApiContext,
  metaobjectGids: string[],
  childGid: string,
): Promise<string | null> {
  if (metaobjectGids.length === 0) return null;
  const fieldMap = await getMetaobjectFieldMap(admin);

  const response = await admin.graphql(
    `#graphql
      query ResolveMetaobjects($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Metaobject {
            id
            fields {
              key
              value
            }
          }
        }
      }
    `,
    { variables: { ids: metaobjectGids } },
  );

  const data = (await response.json()) as {
    data?: {
      nodes?: Array<{
        id: string;
        fields?: Array<{ key: string; value: string }>;
      } | null>;
    };
  };

  for (const node of data.data?.nodes ?? []) {
    if (!node?.fields) continue;
    const childField = node.fields.find((f) => f.key === fieldMap.childKey);
    if (childField?.value === childGid) {
      return node.id;
    }
  }

  return null;
}

/**
 * Updates the quantity field of an existing product_relationship metaobject.
 */
async function updateMetaobjectQuantity(
  admin: AdminApiContext,
  metaobjectGid: string,
  quantity: number,
): Promise<void> {
  const fieldMap = await getMetaobjectFieldMap(admin);

  await admin.graphql(
    `#graphql
      mutation UpdateMetaobject($id: ID!, $metaobject: MetaobjectUpdateInput!) {
        metaobjectUpdate(id: $id, metaobject: $metaobject) {
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        id: metaobjectGid,
        metaobject: {
          fields: [{ key: fieldMap.quantityKey, value: String(quantity) }],
        },
      },
    },
  );
}

// ============================================================================
// Prisma Sync
// ============================================================================

async function upsertPrismaBundle(
  shopId: string,
  parentVariantGid: string,
  children: BundleChild[],
  options?: {
    parentTitle?: string | null;
    parentSku?: string | null;
    expandOnPick?: boolean;
  },
) {
  await prisma.shop.upsert({
    where: { id: shopId },
    update: {},
    create: { id: shopId },
  });

  return prisma.bundle.upsert({
    where: {
      shopId_parentGid: { shopId, parentGid: parentVariantGid },
    },
    update: {
      parentTitle: options?.parentTitle ?? undefined,
      parentSku: options?.parentSku ?? undefined,
      expandOnPick: options?.expandOnPick ?? undefined,
      children: {
        deleteMany: {},
        create: children.map((c) => ({
          childGid: c.childGid,
          quantity: c.quantity,
        })),
      },
    },
    create: {
      shopId,
      parentGid: parentVariantGid,
      parentTitle: options?.parentTitle,
      parentSku: options?.parentSku,
      expandOnPick: options?.expandOnPick ?? false,
      children: {
        create: children.map((c) => ({
          childGid: c.childGid,
          quantity: c.quantity,
        })),
      },
    },
    include: { children: true },
  });
}
