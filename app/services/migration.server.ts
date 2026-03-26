/**
 * Migration Service
 *
 * Scans products for `bundle_base` / `bundle_quant` variant metafields,
 * detects migration status, and creates `product_relationship` metaobject
 * entries for same-product bundles.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getMetaobjectFieldMap } from "./metaobject-setup.server";
import prisma from "../db.server";

// Metafield location for the existing bundle config on variants.
// Detected at runtime via detectBundleMetafieldNamespace().
let BUNDLE_BASE_NAMESPACE = "custom";
const BUNDLE_BASE_KEY = "bundle_base";
let BUNDLE_QUANT_NAMESPACE = "custom";
const BUNDLE_QUANT_KEY = "bundle_quant";

// Metaobject type for the new product relationships
const METAOBJECT_TYPE = "product_relationship";

// Metafield for attaching product_relationship metaobjects to variants
const ATTACHMENT_NAMESPACE = "custom";
const ATTACHMENT_KEY = "product_relationships";

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

export type ProductCategory =
  | "330ml Can"
  | "440ml Can"
  | "750ml Bottle"
  | "375ml Bottle"
  | "Poster"
  | "Miscellaneous";

export interface ProductMigrationInfo {
  gid: string;
  title: string;
  variants: VariantInfo[];
  status: ProductMigrationStatus;
  baseVariant: VariantInfo | null;
  statusDetail: string;
  category: ProductCategory;
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
// Scan Cache
// ============================================================================

export interface CachedScanResult {
  scannedAt: string;
  products: ProductMigrationInfo[];
  namespaces: Record<string, string>;
  diagnostics: MetafieldDiagnostic[];
  counts: Record<string, number>;
}

export async function getCachedScan(
  shopId: string,
): Promise<CachedScanResult | null> {
  const row = await prisma.migrationScanCache.findUnique({
    where: { id: shopId },
  });
  if (!row) return null;
  return {
    scannedAt: row.scannedAt.toISOString(),
    products: JSON.parse(row.productsJson) as ProductMigrationInfo[],
    namespaces: JSON.parse(row.namespacesJson) as Record<string, string>,
    diagnostics: JSON.parse(row.diagnosticsJson) as MetafieldDiagnostic[],
    counts: JSON.parse(row.countsJson) as Record<string, number>,
  };
}

export async function writeScanCache(
  shopId: string,
  data: {
    products: ProductMigrationInfo[];
    namespaces: Record<string, string>;
    diagnostics: MetafieldDiagnostic[];
    counts: Record<string, number>;
  },
): Promise<void> {
  await prisma.migrationScanCache.upsert({
    where: { id: shopId },
    update: {
      scannedAt: new Date(),
      productsJson: JSON.stringify(data.products),
      namespacesJson: JSON.stringify(data.namespaces),
      diagnosticsJson: JSON.stringify(data.diagnostics),
      countsJson: JSON.stringify(data.counts),
    },
    create: {
      id: shopId,
      scannedAt: new Date(),
      productsJson: JSON.stringify(data.products),
      namespacesJson: JSON.stringify(data.namespaces),
      diagnosticsJson: JSON.stringify(data.diagnostics),
      countsJson: JSON.stringify(data.counts),
    },
  });
}

export async function updateProductInCache(
  shopId: string,
  updatedProduct: ProductMigrationInfo,
): Promise<void> {
  const cached = await getCachedScan(shopId);
  if (!cached) return;

  const products = cached.products.map((p) =>
    p.gid === updatedProduct.gid ? updatedProduct : p,
  );

  const counts: Record<string, number> = {};
  for (const p of products) {
    counts[p.status] = (counts[p.status] ?? 0) + 1;
  }

  await writeScanCache(shopId, {
    products,
    namespaces: cached.namespaces,
    diagnostics: cached.diagnostics,
    counts,
  });
}

// ============================================================================
// Category Classification
// ============================================================================

const CATEGORY_RULES: Array<{ pattern: RegExp; category: ProductCategory }> = [
  { pattern: /330/, category: "330ml Can" },
  { pattern: /440/, category: "440ml Can" },
  { pattern: /750/, category: "750ml Bottle" },
  { pattern: /375/, category: "375ml Bottle" },
  { pattern: /\b(a2|a3|poster)\b/i, category: "Poster" },
];

export function classifyProductCategory(
  variants: VariantInfo[],
): ProductCategory {
  for (const { pattern, category } of CATEGORY_RULES) {
    if (variants.some((v) => pattern.test(v.title))) {
      return category;
    }
  }
  return "Miscellaneous";
}

// ============================================================================
// Namespace Detection
// ============================================================================

export interface MetafieldDiagnostic {
  namespace: string;
  key: string;
  value: string;
}

/**
 * Probes variants across the store to find which namespace(s) hold
 * `bundle_base` and `bundle_quant` metafields.
 * Supports mixed namespaces (e.g., bundle_base in "global", bundle_quant in "custom").
 */
export async function detectBundleMetafieldNamespace(
  admin: AdminApiContext,
): Promise<{
  namespaces: Record<string, string>;
  diagnostics: MetafieldDiagnostic[];
}> {
  const diagnostics: MetafieldDiagnostic[] = [];

  const response = await admin.graphql(
    `#graphql
      query ProbeVariantMetafields {
        products(first: 5) {
          nodes {
            variants(first: 10) {
              nodes {
                id
                title
                metafields(first: 30) {
                  nodes {
                    namespace
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    `,
  );

  const data: {
    data?: {
      products?: {
        nodes: Array<{
          variants: {
            nodes: Array<{
              id: string;
              title: string;
              metafields: {
                nodes: Array<{ namespace: string; key: string; value: string }>;
              };
            }>;
          };
        }>;
      };
    };
  } = await response.json();

  let baseNs: string | null = null;
  let quantNs: string | null = null;

  for (const product of data.data?.products?.nodes ?? []) {
    for (const variant of product.variants.nodes) {
      for (const mf of variant.metafields.nodes) {
        if (mf.key === BUNDLE_BASE_KEY) {
          diagnostics.push({
            namespace: mf.namespace,
            key: mf.key,
            value: mf.value,
          });
          if (!baseNs) baseNs = mf.namespace;
        }
        if (mf.key === BUNDLE_QUANT_KEY) {
          diagnostics.push({
            namespace: mf.namespace,
            key: mf.key,
            value: mf.value,
          });
          if (!quantNs) quantNs = mf.namespace;
        }
      }
    }
  }

  if (baseNs) BUNDLE_BASE_NAMESPACE = baseNs;
  if (quantNs) BUNDLE_QUANT_NAMESPACE = quantNs;

  const namespaces: Record<string, string> = {};
  if (baseNs) namespaces[BUNDLE_BASE_KEY] = baseNs;
  if (quantNs) namespaces[BUNDLE_QUANT_KEY] = quantNs;

  return { namespaces, diagnostics };
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
        query GetProductsForMigration(
          $first: Int!
          $after: String
          $baseNs: String!
          $baseKey: String!
          $quantNs: String!
          $quantKey: String!
          $childrenNs: String!
          $childrenKey: String!
        ) {
          products(first: $first, after: $after) {
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
                  bundleBase: metafield(namespace: $baseNs, key: $baseKey) {
                    value
                  }
                  bundleQuant: metafield(namespace: $quantNs, key: $quantKey) {
                    value
                  }
                  bundleChildren: metafield(namespace: $childrenNs, key: $childrenKey) {
                    value
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
          baseNs: BUNDLE_BASE_NAMESPACE,
          baseKey: BUNDLE_BASE_KEY,
          quantNs: BUNDLE_QUANT_NAMESPACE,
          quantKey: BUNDLE_QUANT_KEY,
          childrenNs: ATTACHMENT_NAMESPACE,
          childrenKey: ATTACHMENT_KEY,
        },
      },
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

/**
 * Re-scans a single product by GID and returns updated migration info.
 */
export async function rescanSingleProduct(
  admin: AdminApiContext,
  productGid: string,
): Promise<ProductMigrationInfo | null> {
  const response = await admin.graphql(
    `#graphql
      query RescanProduct(
        $id: ID!
        $baseNs: String!
        $baseKey: String!
        $quantNs: String!
        $quantKey: String!
        $childrenNs: String!
        $childrenKey: String!
      ) {
        product(id: $id) {
          id
          title
          variants(first: 100) {
            nodes {
              id
              title
              sku
              bundleBase: metafield(namespace: $baseNs, key: $baseKey) {
                value
              }
              bundleQuant: metafield(namespace: $quantNs, key: $quantKey) {
                value
              }
              bundleChildren: metafield(namespace: $childrenNs, key: $childrenKey) {
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
        baseNs: BUNDLE_BASE_NAMESPACE,
        baseKey: BUNDLE_BASE_KEY,
        quantNs: BUNDLE_QUANT_NAMESPACE,
        quantKey: BUNDLE_QUANT_KEY,
        childrenNs: ATTACHMENT_NAMESPACE,
        childrenKey: ATTACHMENT_KEY,
      },
    },
  );

  const data = (await response.json()) as {
    data?: {
      product?: {
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
      };
    };
  };

  const product = data.data?.product;
  if (!product) return null;

  const variants: VariantInfo[] = product.variants.nodes.map((v) => ({
    gid: v.id,
    title: v.title,
    sku: v.sku,
    bundleBase: v.bundleBase ? parseBooleanMetafield(v.bundleBase.value) : null,
    bundleQuant: v.bundleQuant ? parseIntMetafield(v.bundleQuant.value) : null,
    hasBundleChildren:
      v.bundleChildren !== null && v.bundleChildren.value !== "[]",
  }));

  return classifyProduct(product.id, product.title, variants);
}

// ============================================================================
// Classification
// ============================================================================

function classifyProduct(
  gid: string,
  title: string,
  variants: VariantInfo[],
): ProductMigrationInfo {
  const category = classifyProductCategory(variants);

  if (variants.length <= 1) {
    return {
      gid,
      title,
      variants,
      status: "skipped",
      baseVariant: null,
      statusDetail: "Single-variant product — nothing to bundle",
      category,
    };
  }

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
      category,
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
        category,
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
      category,
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
      category,
    };
  }

  const baseVariant = baseVariants[0]!;

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
      category,
    };
  }

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
      category,
    };
  }

  return {
    gid,
    title,
    variants,
    status: "ready",
    baseVariant,
    statusDetail: `Ready to migrate. Base: "${baseVariant.title}", ${nonBaseVariants.length} variants to configure.`,
    category,
  };
}

// ============================================================================
// Migrate Single Product
// ============================================================================

/**
 * Migrates a single product: creates product_relationship metaobjects for each
 * non-base variant and attaches them via the product_relationships metafield.
 * Also creates corresponding Bundle/BundleChild rows in Prisma for inventory sync.
 */
export async function migrateProduct(
  admin: AdminApiContext,
  product: ProductMigrationInfo,
  shopId?: string,
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

    if (shopId) {
      await syncBundleToPrisma(shopId, product, nonBaseVariants);
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
 * Creates or updates Bundle/BundleChild Prisma rows to keep the operational
 * database in sync with the Shopify metaobject relationships.
 */
async function syncBundleToPrisma(
  shopId: string,
  product: ProductMigrationInfo,
  nonBaseVariants: VariantInfo[],
): Promise<void> {
  if (!product.baseVariant) return;

  await prisma.shop.upsert({
    where: { id: shopId },
    update: {},
    create: { id: shopId },
  });

  for (const variant of nonBaseVariants) {
    const quantity = variant.bundleQuant ?? 1;

    await prisma.bundle.upsert({
      where: {
        shopId_parentGid: {
          shopId,
          parentGid: variant.gid,
        },
      },
      update: {
        parentTitle: `${product.title} - ${variant.title}`,
        parentSku: variant.sku,
        children: {
          deleteMany: {},
          create: [
            {
              childGid: product.baseVariant.gid,
              quantity,
            },
          ],
        },
      },
      create: {
        shopId,
        parentGid: variant.gid,
        parentTitle: `${product.title} - ${variant.title}`,
        parentSku: variant.sku,
        children: {
          create: [
            {
              childGid: product.baseVariant.gid,
              quantity,
            },
          ],
        },
      },
    });
  }
}

/**
 * Migrates all "ready" products sequentially.
 */
export async function migrateAllReady(
  admin: AdminApiContext,
  products: ProductMigrationInfo[],
  shopId?: string,
): Promise<BulkMigrationSummary> {
  const readyProducts = products.filter((p) => p.status === "ready");
  const results: MigrationResult[] = [];
  let migrated = 0;
  let failed = 0;

  for (const product of readyProducts) {
    const result = await migrateProduct(admin, product, shopId);
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
      query GetExistingBundleChildren($id: ID!, $ns: String!, $key: String!) {
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
