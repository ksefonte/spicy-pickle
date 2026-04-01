import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState, useEffect, useCallback } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  fetchProductRelationships,
  type ProductRelationshipDetail,
} from "../services/migration.server";
import {
  addSingleRelationship,
  removeSingleRelationship,
  reattachProductRelationships,
} from "../services/metaobject-writes.server";
import {
  syncMetaobjectsToPrisma,
  findOrphanedMetaobjects,
  deleteOrphanedMetaobjects,
  reattachOrphanToVariant,
  type OrphanedMetaobject,
} from "../services/metaobject-sync.server";

// ============================================================================
// Types
// ============================================================================

interface ProductSummary {
  gid: string;
  title: string;
  variantCount: number;
  configuredCount: number;
  hasSyncEnabled: number;
}

interface LoaderData {
  products: ProductSummary[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
  search: string;
  shopDomain: string;
}

interface FetchRelationshipsResult {
  intent: "fetch_relationships";
  detail: ProductRelationshipDetail | null;
}

interface AddRelationshipResult {
  intent: "add_relationship";
  success: boolean;
}

interface RemoveRelationshipResult {
  intent: "remove_relationship";
  success: boolean;
}

interface ReattachResult {
  intent: "reattach";
  fixed: number;
}

interface ToggleSyncResult {
  intent: "toggle_sync";
  syncEnabled: boolean;
}

interface ScanOrphansResult {
  intent: "scan_orphans";
  orphans: OrphanedMetaobject[];
}

interface DeleteOrphansResult {
  intent: "delete_orphans";
  deleted: number;
  failed: number;
}

interface ReattachOrphanResult {
  intent: "reattach_orphan";
  success: boolean;
}

interface ErrorResult {
  intent: "error";
  error: string;
}

type ActionResult =
  | FetchRelationshipsResult
  | AddRelationshipResult
  | RemoveRelationshipResult
  | ReattachResult
  | ToggleSyncResult
  | ScanOrphansResult
  | DeleteOrphansResult
  | ReattachOrphanResult
  | ErrorResult;

interface SelectedVariant {
  id: string;
  title: string;
  product?: { title: string };
}

// ============================================================================
// Helpers
// ============================================================================

function extractShopifyId(gid: string): string {
  const match = gid.match(/\/(\d+)$/);
  return match?.[1] ?? gid;
}

const PRODUCTS_PER_PAGE = 25;

const PRODUCTS_QUERY = `#graphql
  query GetProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      nodes {
        id
        title
        totalVariants
        variants(first: 100) {
          nodes {
            id
            metafield(namespace: "custom", key: "product_relationships") {
              value
            }
          }
        }
      }
    }
  }
`;

// ============================================================================
// Loader
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const after = url.searchParams.get("after") ?? undefined;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const response = await admin.graphql(PRODUCTS_QUERY, {
    variables: {
      first: PRODUCTS_PER_PAGE,
      after: after || null,
      query: search || null,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { data } = await response.json();
  const productsData = data?.products;

  const bundles = await db.bundle.findMany({
    where: { shopId: shop },
    select: { parentGid: true, syncEnabled: true },
  });

  const syncMap = new Map<string, boolean>();
  for (const b of bundles) {
    syncMap.set(b.parentGid, b.syncEnabled);
  }

  interface GqlVariantNode {
    id: string;
    metafield?: { value: string } | null;
  }
  interface GqlProductNode {
    id: string;
    title: string;
    totalVariants: number;
    variants?: { nodes?: GqlVariantNode[] };
  }

  const products: ProductSummary[] = (
    (productsData?.nodes ?? []) as GqlProductNode[]
  ).map((p) => {
    const variants: GqlVariantNode[] = p.variants?.nodes ?? [];
    let configuredCount = 0;
    let syncEnabledCount = 0;

    for (const v of variants) {
      const val = v.metafield?.value;
      if (val && val !== "[]") {
        configuredCount++;
      }
      if (syncMap.get(v.id)) {
        syncEnabledCount++;
      }
    }

    return {
      gid: p.id,
      title: p.title,
      variantCount: p.totalVariants,
      configuredCount,
      hasSyncEnabled: syncEnabledCount,
    };
  });

  return {
    products,
    hasNextPage: productsData?.pageInfo?.hasNextPage ?? false,
    hasPreviousPage: productsData?.pageInfo?.hasPreviousPage ?? false,
    endCursor: productsData?.pageInfo?.endCursor ?? null,
    startCursor: productsData?.pageInfo?.startCursor ?? null,
    search,
    shopDomain: shop,
  } satisfies LoaderData;
};

// ============================================================================
// Action
// ============================================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "fetch_relationships") {
    const productGid = formData.get("productGid") as string;
    const detail = await fetchProductRelationships(admin, productGid);
    return {
      intent: "fetch_relationships",
      detail,
    } satisfies FetchRelationshipsResult;
  }

  if (intent === "add_relationship") {
    const variantGid = formData.get("variantGid") as string;
    const childGid = formData.get("childGid") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);
    await addSingleRelationship(admin, variantGid, childGid, quantity);
    try {
      await syncMetaobjectsToPrisma(admin, shop);
    } catch (e) {
      console.error("[Sync] Post-add sync failed:", e);
    }
    return {
      intent: "add_relationship",
      success: true,
    } satisfies AddRelationshipResult;
  }

  if (intent === "remove_relationship") {
    const variantGid = formData.get("variantGid") as string;
    const metaobjectGid = formData.get("metaobjectGid") as string;
    await removeSingleRelationship(admin, variantGid, metaobjectGid);
    try {
      await syncMetaobjectsToPrisma(admin, shop);
    } catch (e) {
      console.error("[Sync] Post-remove sync failed:", e);
    }
    return {
      intent: "remove_relationship",
      success: true,
    } satisfies RemoveRelationshipResult;
  }

  if (intent === "reattach") {
    const productGid = formData.get("productGid") as string;
    const fixed = await reattachProductRelationships(admin, productGid);
    return { intent: "reattach", fixed } satisfies ReattachResult;
  }

  if (intent === "toggle_sync") {
    const bundleId = formData.get("bundleId") as string;
    const bundle = await db.bundle.findUnique({ where: { id: bundleId } });
    if (!bundle) {
      return {
        intent: "error",
        error: "Bundle not found",
      } satisfies ErrorResult;
    }
    const updated = await db.bundle.update({
      where: { id: bundleId },
      data: { syncEnabled: !bundle.syncEnabled },
    });
    return {
      intent: "toggle_sync",
      syncEnabled: updated.syncEnabled,
    } satisfies ToggleSyncResult;
  }

  if (intent === "scan_orphans") {
    const orphans = await findOrphanedMetaobjects(admin);
    return { intent: "scan_orphans", orphans } satisfies ScanOrphansResult;
  }

  if (intent === "delete_orphans") {
    const gids = JSON.parse(formData.get("gids") as string) as string[];
    const result = await deleteOrphanedMetaobjects(admin, gids);
    return {
      intent: "delete_orphans",
      ...result,
    } satisfies DeleteOrphansResult;
  }

  if (intent === "reattach_orphan") {
    const metaobjectGid = formData.get("metaobjectGid") as string;
    const variantGid = formData.get("variantGid") as string;
    await reattachOrphanToVariant(admin, metaobjectGid, variantGid);
    return {
      intent: "reattach_orphan",
      success: true,
    } satisfies ReattachOrphanResult;
  }

  return { intent: "error", error: "Unknown intent" } satisfies ErrorResult;
};

// ============================================================================
// Component
// ============================================================================

export default function ProductRelationshipsPage() {
  const {
    products,
    hasNextPage,
    hasPreviousPage,
    endCursor,
    startCursor,
    search,
    shopDomain,
  } = useLoaderData<typeof loader>() as LoaderData;

  const [searchParams, setSearchParams] = useSearchParams();
  const [searchValue, setSearchValue] = useState(search);
  const [modalProductGid, setModalProductGid] = useState<string | null>(null);

  const handleSearch = () => {
    const params = new URLSearchParams();
    if (searchValue.trim()) params.set("search", searchValue.trim());
    setSearchParams(params);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const goNext = () => {
    const params = new URLSearchParams(searchParams);
    if (endCursor) params.set("after", endCursor);
    params.delete("before");
    setSearchParams(params);
  };

  const goPrevious = () => {
    const params = new URLSearchParams(searchParams);
    if (startCursor) params.set("before", startCursor);
    params.delete("after");
    setSearchParams(params);
  };

  return (
    <s-page heading="Product Relationships">
      <s-section>
        <s-stack>
          {/* Search bar */}
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              type="text"
              placeholder="Search products..."
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              style={{
                flex: 1,
                padding: "8px 12px",
                fontSize: "14px",
                border: "1px solid var(--p-color-border, #c9cccf)",
                borderRadius: "8px",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={handleSearch}
              style={{
                padding: "8px 16px",
                fontSize: "14px",
                borderRadius: "8px",
                border: "none",
                background: "#2c6ecb",
                color: "white",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Search
            </button>
          </div>

          {/* Product table */}
          {products.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px" }}>
              <s-text>
                {search
                  ? "No products found matching your search."
                  : "No products found."}
              </s-text>
            </div>
          ) : (
            <div
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "14px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      background: "#f9fafb",
                      borderBottom: "1px solid #e0e0e0",
                      textAlign: "left",
                    }}
                  >
                    <th style={{ padding: "12px 16px", fontWeight: 600 }}>
                      Product
                    </th>
                    <th
                      style={{
                        padding: "12px 16px",
                        fontWeight: 600,
                        width: "100px",
                        textAlign: "center",
                      }}
                    >
                      Variants
                    </th>
                    <th
                      style={{
                        padding: "12px 16px",
                        fontWeight: 600,
                        width: "120px",
                        textAlign: "center",
                      }}
                    >
                      Configured
                    </th>
                    <th
                      style={{
                        padding: "12px 16px",
                        fontWeight: 600,
                        width: "120px",
                        textAlign: "center",
                      }}
                    >
                      Sync
                    </th>
                    <th
                      style={{
                        padding: "12px 16px",
                        fontWeight: 600,
                        width: "100px",
                        textAlign: "right",
                      }}
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr
                      key={product.gid}
                      style={{ borderBottom: "1px solid #f0f0f0" }}
                    >
                      <td style={{ padding: "12px 16px", fontWeight: 500 }}>
                        {product.title}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          textAlign: "center",
                          color: "#6d7175",
                        }}
                      >
                        {product.variantCount}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center" }}>
                        <span
                          style={{
                            color:
                              product.configuredCount > 0
                                ? "#008060"
                                : "#8c9196",
                            fontWeight: 600,
                          }}
                        >
                          {product.configuredCount}/{product.variantCount}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          textAlign: "center",
                          color:
                            product.hasSyncEnabled > 0 ? "#008060" : "#8c9196",
                        }}
                      >
                        {product.hasSyncEnabled > 0
                          ? `${product.hasSyncEnabled} enabled`
                          : "\u2014"}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>
                        <button
                          type="button"
                          onClick={() => setModalProductGid(product.gid)}
                          style={{
                            padding: "6px 14px",
                            fontSize: "13px",
                            borderRadius: "6px",
                            border: "1px solid #2c6ecb",
                            background: "white",
                            color: "#2c6ecb",
                            cursor: "pointer",
                            fontWeight: 600,
                          }}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 0",
            }}
          >
            <button
              type="button"
              onClick={goPrevious}
              disabled={!hasPreviousPage}
              style={{
                padding: "8px 16px",
                fontSize: "13px",
                borderRadius: "6px",
                border: "1px solid #c9cccf",
                background: hasPreviousPage ? "white" : "#f6f6f7",
                color: hasPreviousPage ? "#202223" : "#8c9196",
                cursor: hasPreviousPage ? "pointer" : "not-allowed",
                fontWeight: 600,
              }}
            >
              &larr; Previous
            </button>
            <span style={{ color: "#6d7175", fontSize: "13px" }}>
              Showing {products.length} product
              {products.length !== 1 ? "s" : ""}
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={!hasNextPage}
              style={{
                padding: "8px 16px",
                fontSize: "13px",
                borderRadius: "6px",
                border: "1px solid #c9cccf",
                background: hasNextPage ? "white" : "#f6f6f7",
                color: hasNextPage ? "#202223" : "#8c9196",
                cursor: hasNextPage ? "pointer" : "not-allowed",
                fontWeight: 600,
              }}
            >
              Next &rarr;
            </button>
          </div>
        </s-stack>
      </s-section>

      <OrphanSection />

      {modalProductGid && (
        <ProductDetailModal
          productGid={modalProductGid}
          shopDomain={shopDomain}
          onClose={() => setModalProductGid(null)}
        />
      )}
    </s-page>
  );
}

// ============================================================================
// Orphaned Metaobjects Section
// ============================================================================

function OrphanSection() {
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const [orphans, setOrphans] = useState<OrphanedMetaobject[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reattachGid, setReattachGid] = useState<string | null>(null);

  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;

    if ("orphans" in fetcher.data) {
      setOrphans(fetcher.data.orphans);
      setSelected(new Set());
    }

    if ("deleted" in fetcher.data) {
      void shopify.toast.show(
        `Deleted ${fetcher.data.deleted} orphan${fetcher.data.deleted !== 1 ? "s" : ""}` +
          (fetcher.data.failed > 0 ? ` (${fetcher.data.failed} failed)` : ""),
      );
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit({ intent: "scan_orphans" }, { method: "POST" });
    }

    if (
      "success" in fetcher.data &&
      fetcher.data.intent === "reattach_orphan"
    ) {
      void shopify.toast.show("Orphan reattached successfully");
      setReattachGid(null);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit({ intent: "scan_orphans" }, { method: "POST" });
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSelect = (gid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  const toggleAll = () => {
    if (!orphans) return;
    if (selected.size === orphans.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(orphans.map((o) => o.gid)));
    }
  };

  const handleDelete = () => {
    if (selected.size === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "delete_orphans", gids: JSON.stringify([...selected]) },
      { method: "POST" },
    );
  };

  const handleReattach = (variantGid: string) => {
    if (!reattachGid) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "reattach_orphan", metaobjectGid: reattachGid, variantGid },
      { method: "POST" },
    );
  };

  const openReattachPicker = async (metaobjectGid: string) => {
    setReattachGid(metaobjectGid);
    const sel = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
      filter: { variants: true },
    });
    const product = sel?.[0];
    const variant = product?.variants?.[0];
    if (variant?.id) {
      handleReattach(variant.id);
    } else {
      setReattachGid(null);
    }
  };

  return (
    <s-section heading="Orphaned Metaobjects">
      <s-stack direction="block" gap="base">
        <s-text>
          Orphaned product_relationship metaobjects exist in your Shopify store
          but are not attached to any variant. These can accumulate from failed
          deletions or manual edits.
        </s-text>

        {orphans === null ? (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              fetcher.submit({ intent: "scan_orphans" }, { method: "POST" });
            }}
            style={{
              padding: "8px 20px",
              fontSize: "14px",
              borderRadius: "8px",
              border: "1px solid #2c6ecb",
              background: "#2c6ecb",
              color: "white",
              cursor: isBusy ? "not-allowed" : "pointer",
              fontWeight: 600,
              opacity: isBusy ? 0.6 : 1,
            }}
          >
            {isBusy ? "Scanning..." : "Scan for Orphans"}
          </button>
        ) : orphans.length === 0 ? (
          <div
            style={{
              padding: "20px",
              textAlign: "center",
              background: "#f1f8f5",
              borderRadius: "8px",
              border: "1px solid #c9e8d9",
            }}
          >
            <s-text tone="success">
              <strong>No orphaned metaobjects found.</strong>
            </s-text>
            <div style={{ marginTop: "8px" }}>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  // eslint-disable-next-line @typescript-eslint/no-floating-promises
                  fetcher.submit(
                    { intent: "scan_orphans" },
                    { method: "POST" },
                  );
                }}
                style={{
                  padding: "6px 14px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid #c9cccf",
                  background: "white",
                  color: "#202223",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Rescan
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <s-text>
                Found{" "}
                <strong>
                  {orphans.length} orphan{orphans.length !== 1 ? "s" : ""}
                </strong>
              </s-text>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    fetcher.submit(
                      { intent: "scan_orphans" },
                      { method: "POST" },
                    );
                  }}
                  style={{
                    padding: "6px 14px",
                    fontSize: "13px",
                    borderRadius: "6px",
                    border: "1px solid #c9cccf",
                    background: "white",
                    color: "#202223",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  Rescan
                </button>
                <button
                  type="button"
                  disabled={selected.size === 0 || isBusy}
                  onClick={handleDelete}
                  style={{
                    padding: "6px 14px",
                    fontSize: "13px",
                    borderRadius: "6px",
                    border: "1px solid #d82c0d",
                    background: selected.size > 0 ? "#d82c0d" : "#f6f6f7",
                    color: selected.size > 0 ? "white" : "#8c9196",
                    cursor:
                      selected.size > 0 && !isBusy ? "pointer" : "not-allowed",
                    fontWeight: 600,
                  }}
                >
                  Delete Selected ({selected.size})
                </button>
              </div>
            </div>

            <div
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "14px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      background: "#f9fafb",
                      borderBottom: "1px solid #e0e0e0",
                      textAlign: "left",
                    }}
                  >
                    <th style={{ padding: "10px 12px", width: "40px" }}>
                      <input
                        type="checkbox"
                        checked={selected.size === orphans.length}
                        onChange={toggleAll}
                      />
                    </th>
                    <th style={{ padding: "10px 12px", fontWeight: 600 }}>
                      Child Variant
                    </th>
                    <th
                      style={{
                        padding: "10px 12px",
                        fontWeight: 600,
                        width: "80px",
                        textAlign: "center",
                      }}
                    >
                      Qty
                    </th>
                    <th
                      style={{
                        padding: "10px 12px",
                        fontWeight: 600,
                        width: "200px",
                        textAlign: "center",
                      }}
                    >
                      Metaobject ID
                    </th>
                    <th
                      style={{
                        padding: "10px 12px",
                        fontWeight: 600,
                        width: "120px",
                        textAlign: "right",
                      }}
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orphans.map((orphan) => (
                    <tr
                      key={orphan.gid}
                      style={{ borderBottom: "1px solid #f0f0f0" }}
                    >
                      <td style={{ padding: "10px 12px" }}>
                        <input
                          type="checkbox"
                          checked={selected.has(orphan.gid)}
                          onChange={() => toggleSelect(orphan.gid)}
                        />
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        {orphan.childTitle ?? (
                          <span
                            style={{ color: "#8c9196", fontStyle: "italic" }}
                          >
                            Unknown variant
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          textAlign: "center",
                          fontWeight: 600,
                        }}
                      >
                        {orphan.quantity}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          textAlign: "center",
                          fontFamily: "monospace",
                          fontSize: "12px",
                          color: "#6d7175",
                        }}
                      >
                        {extractShopifyId(orphan.gid)}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "right" }}>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            void openReattachPicker(orphan.gid);
                          }}
                          style={{
                            padding: "4px 10px",
                            fontSize: "12px",
                            borderRadius: "4px",
                            border: "1px solid #2c6ecb",
                            background: "white",
                            color: "#2c6ecb",
                            cursor: isBusy ? "not-allowed" : "pointer",
                            fontWeight: 600,
                          }}
                        >
                          Reattach
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </s-stack>
    </s-section>
  );
}

// ============================================================================
// Product Detail Modal
// ============================================================================

function ProductDetailModal({
  productGid,
  shopDomain,
  onClose,
}: {
  productGid: string;
  shopDomain: string;
  onClose: () => void;
}) {
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const [detail, setDetail] = useState<ProductRelationshipDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [addChild, setAddChild] = useState<SelectedVariant | null>(null);
  const [addQuantity, setAddQuantity] = useState(1);

  const productId = extractShopifyId(productGid);
  const adminUrl = `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/products/${productId}`;

  const refreshDetail = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "fetch_relationships", productGid },
      { method: "POST" },
    );
  }, [productGid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshDetail();
  }, [productGid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!fetcher.data) return;

    if ("detail" in fetcher.data) {
      setDetail(fetcher.data.detail);
      setLoading(false);
    }

    if ("success" in fetcher.data && fetcher.data.success) {
      setAddingFor(null);
      setAddChild(null);
      setAddQuantity(1);
      refreshDetail();
    }

    if ("fixed" in fetcher.data) {
      refreshDetail();
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const isBusy = fetcher.state !== "idle";

  const openChildPicker = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
      filter: { variants: true },
    });
    const product = selected?.[0];
    const variant = product?.variants?.[0];
    if (variant?.id && product) {
      setAddChild({
        id: variant.id,
        title: variant.title ?? "Default Title",
        product: { title: product.title },
      });
    }
  };

  const handleAddSubmit = (variantGid: string) => {
    if (!addChild) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "add_relationship",
        variantGid,
        childGid: addChild.id,
        quantity: String(addQuantity),
      },
      { method: "POST" },
    );
  };

  const handleRemove = (variantGid: string, metaobjectGid: string) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "remove_relationship", variantGid, metaobjectGid },
      { method: "POST" },
    );
  };

  const handleReattach = () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ intent: "reattach", productGid }, { method: "POST" });
  };

  const getChildDisplayTitle = (v: SelectedVariant): string => {
    const productTitle = v.product?.title ?? "Unknown Product";
    return v.title === "Default Title"
      ? productTitle
      : `${productTitle} - ${v.title}`;
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.4)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        style={{
          background: "white",
          borderRadius: "12px",
          width: "min(90vw, 800px)",
          maxHeight: "80vh",
          overflow: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            borderBottom: "1px solid #e0e0e0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            position: "sticky",
            top: 0,
            background: "white",
            zIndex: 1,
            borderRadius: "12px 12px 0 0",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>
              {detail?.productTitle ?? "Loading..."}
            </h2>
            <a
              href={adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#8c9196", fontSize: "12px" }}
            >
              Open in Shopify admin &#8599;
            </a>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              onClick={handleReattach}
              disabled={isBusy}
              style={{
                padding: "6px 12px",
                fontSize: "13px",
                borderRadius: "6px",
                border: "1px solid #b98900",
                background: "#fdf8e8",
                color: "#b98900",
                cursor: isBusy ? "not-allowed" : "pointer",
                fontWeight: 600,
              }}
              title="Re-writes metafield values to fix admin display issues"
            >
              Fix Attachments
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                fontSize: "24px",
                cursor: "pointer",
                color: "#6d7175",
                lineHeight: 1,
                padding: "4px",
              }}
            >
              &times;
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px" }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: "40px" }}>
              <s-text>Loading relationships...</s-text>
            </div>
          ) : !detail ? (
            <div style={{ textAlign: "center", padding: "40px" }}>
              <s-text tone="critical">Failed to load product details</s-text>
            </div>
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "16px" }}
            >
              {detail.variants.map((variant) => {
                const isAdding = addingFor === variant.gid;
                return (
                  <div
                    key={variant.gid}
                    style={{
                      border: "1px solid #e0e0e0",
                      borderRadius: "8px",
                      overflow: "hidden",
                    }}
                  >
                    {/* Variant header */}
                    <div
                      style={{
                        padding: "12px 16px",
                        background: "#f9fafb",
                        borderBottom:
                          variant.relationships.length > 0 || isAdding
                            ? "1px solid #e0e0e0"
                            : "none",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <span style={{ fontWeight: 600 }}>{variant.title}</span>
                        {variant.sku && (
                          <span
                            style={{
                              color: "#8c9196",
                              marginLeft: "8px",
                              fontSize: "13px",
                            }}
                          >
                            SKU: {variant.sku}
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "8px",
                          alignItems: "center",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "12px",
                            color:
                              variant.relationships.length > 0
                                ? "#008060"
                                : "#8c9196",
                            fontWeight: 600,
                          }}
                        >
                          {variant.relationships.length} relationship
                          {variant.relationships.length !== 1 ? "s" : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setAddingFor(isAdding ? null : variant.gid);
                            setAddChild(null);
                            setAddQuantity(1);
                          }}
                          style={{
                            padding: "4px 10px",
                            fontSize: "12px",
                            borderRadius: "4px",
                            border: "1px solid #2c6ecb",
                            background: isAdding ? "#2c6ecb" : "white",
                            color: isAdding ? "white" : "#2c6ecb",
                            cursor: "pointer",
                            fontWeight: 600,
                          }}
                        >
                          {isAdding ? "Cancel" : "+ Add"}
                        </button>
                      </div>
                    </div>

                    {/* Existing relationships */}
                    {variant.relationships.length > 0 && (
                      <table
                        style={{
                          width: "100%",
                          fontSize: "13px",
                          borderCollapse: "collapse",
                        }}
                      >
                        <thead>
                          <tr
                            style={{
                              borderBottom: "1px solid #eee",
                              textAlign: "left",
                            }}
                          >
                            <th
                              style={{
                                padding: "8px 16px",
                                fontWeight: 600,
                                color: "#6d7175",
                              }}
                            >
                              Child Variant
                            </th>
                            <th
                              style={{
                                padding: "8px 16px",
                                fontWeight: 600,
                                color: "#6d7175",
                              }}
                            >
                              SKU
                            </th>
                            <th
                              style={{
                                padding: "8px 16px",
                                fontWeight: 600,
                                color: "#6d7175",
                                width: "80px",
                              }}
                            >
                              Qty
                            </th>
                            <th
                              style={{
                                padding: "8px 16px",
                                fontWeight: 600,
                                color: "#6d7175",
                                width: "80px",
                                textAlign: "right",
                              }}
                            ></th>
                          </tr>
                        </thead>
                        <tbody>
                          {variant.relationships.map((rel) => (
                            <tr
                              key={rel.metaobjectGid}
                              style={{ borderBottom: "1px solid #f0f0f0" }}
                            >
                              <td style={{ padding: "8px 16px" }}>
                                {rel.childVariantTitle}
                              </td>
                              <td
                                style={{
                                  padding: "8px 16px",
                                  color: "#6d7175",
                                }}
                              >
                                {rel.childSku ?? "\u2014"}
                              </td>
                              <td
                                style={{
                                  padding: "8px 16px",
                                  fontWeight: 600,
                                }}
                              >
                                {rel.quantity}
                              </td>
                              <td
                                style={{
                                  padding: "8px 16px",
                                  textAlign: "right",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleRemove(variant.gid, rel.metaobjectGid)
                                  }
                                  disabled={isBusy}
                                  style={{
                                    padding: "2px 8px",
                                    fontSize: "12px",
                                    borderRadius: "4px",
                                    border: "1px solid #d72c0d",
                                    background: "white",
                                    color: "#d72c0d",
                                    cursor: isBusy ? "not-allowed" : "pointer",
                                  }}
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {/* Add relationship form */}
                    {isAdding && (
                      <div
                        style={{
                          padding: "12px 16px",
                          background: "#f0f6ff",
                          borderTop:
                            variant.relationships.length > 0
                              ? "1px solid #e0e0e0"
                              : "none",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: "12px",
                            alignItems: "flex-end",
                            flexWrap: "wrap",
                          }}
                        >
                          <div style={{ flex: 1, minWidth: "200px" }}>
                            <div
                              style={{
                                fontSize: "12px",
                                fontWeight: 600,
                                marginBottom: "4px",
                              }}
                            >
                              Child Variant
                            </div>
                            {addChild ? (
                              <div
                                style={{
                                  display: "flex",
                                  gap: "8px",
                                  alignItems: "center",
                                }}
                              >
                                <span style={{ fontSize: "13px" }}>
                                  {getChildDisplayTitle(addChild)}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void openChildPicker()}
                                  style={{
                                    padding: "2px 8px",
                                    fontSize: "12px",
                                    borderRadius: "4px",
                                    border: "1px solid var(--p-color-border)",
                                    background: "white",
                                    cursor: "pointer",
                                  }}
                                >
                                  Change
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => void openChildPicker()}
                                style={{
                                  padding: "6px 12px",
                                  fontSize: "13px",
                                  borderRadius: "6px",
                                  border: "1px solid var(--p-color-border)",
                                  background: "white",
                                  cursor: "pointer",
                                }}
                              >
                                Select Variant...
                              </button>
                            )}
                          </div>
                          <div style={{ width: "80px" }}>
                            <div
                              style={{
                                fontSize: "12px",
                                fontWeight: 600,
                                marginBottom: "4px",
                              }}
                            >
                              Quantity
                            </div>
                            <input
                              type="number"
                              min={1}
                              value={addQuantity}
                              onChange={(e) =>
                                setAddQuantity(
                                  parseInt(e.target.value, 10) || 1,
                                )
                              }
                              style={{
                                width: "100%",
                                padding: "6px 8px",
                                border: "1px solid var(--p-color-border)",
                                borderRadius: "4px",
                                fontSize: "13px",
                              }}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => handleAddSubmit(variant.gid)}
                            disabled={!addChild || isBusy}
                            style={{
                              padding: "6px 16px",
                              fontSize: "13px",
                              borderRadius: "6px",
                              border: "none",
                              background:
                                addChild && !isBusy ? "#008060" : "#ccc",
                              color: "white",
                              cursor:
                                addChild && !isBusy ? "pointer" : "not-allowed",
                              fontWeight: 600,
                            }}
                          >
                            {isBusy ? "Saving..." : "Save"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Error Boundary / Headers
// ============================================================================

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
