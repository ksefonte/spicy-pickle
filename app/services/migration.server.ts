/**
 * Migration Service
 *
 * Scans products for `bundle_base` / `bundle_quant` variant metafields,
 * detects migration status, and creates `product_relationship` metaobject
 * entries for same-product bundles.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Metafield location for the existing bundle config on variants.
// These are merchant-created metafields set up outside the app.
const BUNDLE_BASE_NAMESPACE = "custom";
const BUNDLE_BASE_KEY = "bundle_base";
const BUNDLE_QUANT_NAMESPACE = "custom";
const BUNDLE_QUANT_KEY = "bundle_quant";

// Metaobject type for the new product relationships
const METAOBJECT_TYPE = "product_relationship";

// App-owned metafield for attaching relationships to variants
const ATTACHMENT_NAMESPACE = "$app:spicy_pickle";
const ATTACHMENT_KEY = "bundle_children";

// ============================================================================
// Types
// ============================================================================

export type ProductMigrationStatus =
  | "ready"
  | "migrated"
  | "ambiguous"
  | "no_base"
  | "missing_data"
  | "error"
  | "skipped";

export interface VariantInfo {
  gid: string;
  title: string;
  sku: string | null;
  bundleBase: boolean | null;
  bundleQuant: number | null;
  hasBundleChildren: boolean;
}

export interface ProductMigrationInfo {
  gid: string;
  title: string;
  variants: VariantInfo[];
  status: ProductMigrationStatus;
  baseVariant: VariantInfo | null;
  statusDetail: string;
}

export interface MigrationResult {
  productGid: string;
  success: boolean;
  error?: string;
  relationshipsCreated: number;
}

export interface BulkMigrationSummary {
  migrated: number;
  skipped: number;
  failed: number;
  results: MigrationResult[];
}

// ============================================================================
// Scan Products
// ============================================================================

/**
 * Fetches all products and their variants with bundle metafields,
 * then classifies each product's migration status.
 */
export async function scanProducts(
  admin: AdminApiContext,
): Promise<ProductMigrationInfo[]> {
  const products: ProductMigrationInfo[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query GetProductsForMigration($first: Int!, $after: String) {
          products(first: 50, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              variants(first: 100) {
                nodes {
                  id
                  title
                  sku
                  bundleBase: metafield(namespace: "${BUNDLE_BASE_NAMESPACE}", key: "${BUNDLE_BASE_KEY}") {
                    value
                  }
                  bundleQuant: metafield(namespace: "${BUNDLE_QUANT_NAMESPACE}", key: "${BUNDLE_QUANT_KEY}") {
                    value
                  }
                  bundleChildren: metafield(namespace: "${ATTACHMENT_NAMESPACE}", key: "${ATTACHMENT_KEY}") {
                    value
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { first: 50, after: cursor } },
    );

    const data: {
      data?: {
        products?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            title: string;
            variants: {
              nodes: Array<{
                id: string;
                title: string;
                sku: string | null;
                bundleBase: { value: string } | null;
                bundleQuant: { value: string } | null;
                bundleChildren: { value: string } | null;
              }>;
            };
          }>;
        };
      };
    } = await response.json();

    const productsData = data.data?.products;
    if (!productsData) break;

    for (const product of productsData.nodes) {
      const variants: VariantInfo[] = product.variants.nodes.map((v) => ({
        gid: v.id,
        title: v.title,
        sku: v.sku,
        bundleBase: v.bundleBase
          ? parseBooleanMetafield(v.bundleBase.value)
          : null,
        bundleQuant: v.bundleQuant
          ? parseIntMetafield(v.bundleQuant.value)
          : null,
        hasBundleChildren:
          v.bundleChildren !== null && v.bundleChildren.value !== "[]",
      }));

      products.push(classifyProduct(product.id, product.title, variants));
    }

    hasNextPage = productsData.pageInfo.hasNextPage;
    cursor = productsData.pageInfo.endCursor;
  }

  return products;
}

// ============================================================================
// Classification
// ============================================================================

function classifyProduct(
  gid: string,
  title: string,
  variants: VariantInfo[],
): ProductMigrationInfo {
  if (variants.length <= 1) {
    return {
      gid,
      title,
      variants,
      status: "skipped",
      baseVariant: null,
      statusDetail: "Single-variant product — nothing to bundle",
    };
  }

  // Check if already migrated (any non-base variant has bundle_children)
  const nonBaseVariants = variants.filter((v) => v.bundleBase !== true);
  const migratedVariants = nonBaseVariants.filter((v) => v.hasBundleChildren);
  if (
    migratedVariants.length > 0 &&
    migratedVariants.length === nonBaseVariants.length
  ) {
    const baseVariant = variants.find((v) => v.bundleBase === true) ?? null;
    return {
      gid,
      title,
      variants,
      status: "migrated",
      baseVariant,
      statusDetail: "All non-base variants have product relationships attached",
    };
  }

  const baseVariants = variants.filter((v) => v.bundleBase === true);

  if (baseVariants.length === 0) {
    const hasAnyBundleMetafields = variants.some(
      (v) => v.bundleBase !== null || v.bundleQuant !== null,
    );
    if (!hasAnyBundleMetafields) {
      return {
        gid,
        title,
        variants,
        status: "skipped",
        baseVariant: null,
        statusDetail: "No bundle metafields configured on any variant",
      };
    }
    return {
      gid,
      title,
      variants,
      status: "no_base",
      baseVariant: null,
      statusDetail:
        "No variant has bundle_base=True. May be a mixed pack requiring manual setup.",
    };
  }

  if (baseVariants.length > 1) {
    const baseNames = baseVariants.map((v) => `"${v.title}"`).join(", ");
    return {
      gid,
      title,
      variants,
      status: "ambiguous",
      baseVariant: null,
      statusDetail: `Multiple base variants found: ${baseNames}`,
    };
  }

  const baseVariant = baseVariants[0]!;

  // Check non-base variants have bundle_quant
  const missingQuant = nonBaseVariants.filter(
    (v) => v.bundleQuant === null && v.bundleBase !== true,
  );
  if (missingQuant.length > 0) {
    const names = missingQuant.map((v) => `"${v.title}"`).join(", ");
    return {
      gid,
      title,
      variants,
      status: "missing_data",
      baseVariant,
      statusDetail: `Missing bundle_quant on: ${names}`,
    };
  }

  // Partially migrated
  if (migratedVariants.length > 0) {
    const remaining = nonBaseVariants.filter((v) => !v.hasBundleChildren);
    const names = remaining.map((v) => `"${v.title}"`).join(", ");
    return {
      gid,
      title,
      variants,
      status: "ready",
      baseVariant,
      statusDetail: `Partially migrated. Remaining: ${names}`,
    };
  }

  return {
    gid,
    title,
    variants,
    status: "ready",
    baseVariant,
    statusDetail: `Ready to migrate. Base: "${baseVariant.title}", ${nonBaseVariants.length} variants to configure.`,
  };
}

// ============================================================================
// Migrate Single Product
// ============================================================================

/**
 * Migrates a single product: creates product_relationship metaobjects for each
 * non-base variant and attaches them via the bundle_children metafield.
 */
export async function migrateProduct(
  admin: AdminApiContext,
  product: ProductMigrationInfo,
): Promise<MigrationResult> {
  if (product.status !== "ready" || !product.baseVariant) {
    return {
      productGid: product.gid,
      success: false,
      error: `Cannot migrate: status is "${product.status}"`,
      relationshipsCreated: 0,
    };
  }

  const baseVariantGid = product.baseVariant.gid;
  const nonBaseVariants = product.variants.filter(
    (v) =>
      v.gid !== baseVariantGid && v.bundleBase !== true && !v.hasBundleChildren,
  );

  let created = 0;

  try {
    for (const variant of nonBaseVariants) {
      const quantity = variant.bundleQuant ?? 1;

      const metaobjectGid = await createProductRelationship(
        admin,
        baseVariantGid,
        quantity,
      );

      await attachRelationshipToVariant(admin, variant.gid, metaobjectGid);
      created++;
    }

    return {
      productGid: product.gid,
      success: true,
      relationshipsCreated: created,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      productGid: product.gid,
      success: false,
      error: message,
      relationshipsCreated: created,
    };
  }
}

/**
 * Migrates all "ready" products sequentially.
 */
export async function migrateAllReady(
  admin: AdminApiContext,
  products: ProductMigrationInfo[],
): Promise<BulkMigrationSummary> {
  const readyProducts = products.filter((p) => p.status === "ready");
  const results: MigrationResult[] = [];
  let migrated = 0;
  let failed = 0;

  for (const product of readyProducts) {
    const result = await migrateProduct(admin, product);
    results.push(result);
    if (result.success) {
      migrated++;
    } else {
      failed++;
    }
  }

  return {
    migrated,
    skipped: products.length - readyProducts.length,
    failed,
    results,
  };
}

// ============================================================================
// Metaobject + Metafield Helpers
// ============================================================================

async function createProductRelationship(
  admin: AdminApiContext,
  childVariantGid: string,
  quantity: number,
): Promise<string> {
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
            { key: "child", value: childVariantGid },
            { key: "quantity", value: String(quantity) },
          ],
        },
      },
    },
  );

  const data: {
    data?: {
      metaobjectCreate?: {
        metaobject?: { id: string };
        userErrors?: Array<{ field: string; message: string }>;
      };
    };
  } = await response.json();

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

async function attachRelationshipToVariant(
  admin: AdminApiContext,
  variantGid: string,
  metaobjectGid: string,
): Promise<void> {
  // Read existing attachments to append rather than overwrite
  const existing = await getExistingAttachments(admin, variantGid);
  const allGids = [...existing, metaobjectGid];

  const response = await admin.graphql(
    `#graphql
      mutation AttachBundleChildren($metafields: [MetafieldsSetInput!]!) {
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
            value: JSON.stringify(allGids),
          },
        ],
      },
    },
  );

  const data: {
    data?: {
      metafieldsSet?: {
        userErrors?: Array<{ field: string; message: string }>;
      };
    };
  } = await response.json();

  const errors = data.data?.metafieldsSet?.userErrors;
  if (errors && errors.length > 0) {
    throw new Error(`Metafield attach error: ${JSON.stringify(errors)}`);
  }
}

async function getExistingAttachments(
  admin: AdminApiContext,
  variantGid: string,
): Promise<string[]> {
  const response = await admin.graphql(
    `#graphql
      query GetExistingBundleChildren($id: ID!, $namespace: String!, $key: String!) {
        productVariant(id: $id) {
          metafield(namespace: $namespace, key: $key) {
            value
          }
        }
      }
    `,
    {
      variables: {
        id: variantGid,
        namespace: ATTACHMENT_NAMESPACE,
        key: ATTACHMENT_KEY,
      },
    },
  );

  const data: {
    data?: {
      productVariant?: {
        metafield?: { value: string } | null;
      };
    };
  } = await response.json();

  const value = data.data?.productVariant?.metafield?.value;
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // ignore parse errors
  }
  return [];
}

// ============================================================================
// Metafield Value Parsers
// ============================================================================

function parseBooleanMetafield(value: string): boolean | null {
  if (value === "true" || value === "True" || value === "1") return true;
  if (value === "false" || value === "False" || value === "0") return false;
  return null;
}

function parseIntMetafield(value: string): number | null {
  const num = parseInt(value, 10);
  return isNaN(num) ? null : num;
}
