import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useState, useCallback, useEffect, useRef } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  syncMetaobjectsToPrisma,
  type SyncStats,
} from "../services/metaobject-sync.server";
import {
  scanProducts,
  migrateProduct,
  migrateAllReady,
  rescanSingleProduct,
  updateProductInCache,
  detectBundleMetafieldNamespace,
  getCachedScan,
  writeScanCache,
  fetchProductRelationships,
  type ProductMigrationInfo,
  type ProductMigrationStatus,
  type ProductCategory,
  type VariantInfo,
  type MigrationResult,
  type BulkMigrationSummary,
  type MetafieldDiagnostic,
  type ProductRelationshipDetail,
} from "../services/migration.server";
import {
  addSingleRelationship,
  removeSingleRelationship,
  reattachProductRelationships,
} from "../services/metaobject-writes.server";
import { useAppBridge } from "@shopify/app-bridge-react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const cached = await getCachedScan(session.shop);
  if (cached) {
    return {
      intent: "scan" as const,
      shopDomain: session.shop,
      products: cached.products,
      namespaces: cached.namespaces,
      diagnostics: cached.diagnostics,
      counts: cached.counts,
      scannedAt: cached.scannedAt,
    };
  }
  return { intent: "empty" as const, shopDomain: session.shop };
};

interface ScanResult {
  intent: "scan";
  shopDomain: string;
  products: ProductMigrationInfo[];
  namespaces: Record<string, string>;
  diagnostics: MetafieldDiagnostic[];
  counts: Record<string, number>;
  scannedAt: string;
}

interface MigrateOneResult {
  intent: "migrate_one";
  result: MigrationResult;
}

interface MigrateAllResult {
  intent: "migrate_all";
  summary: BulkMigrationSummary;
}

interface SyncPrismaResult {
  intent: "sync_prisma";
  stats: SyncStats;
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

type ActionResult =
  | ScanResult
  | MigrateOneResult
  | MigrateAllResult
  | SyncPrismaResult
  | FetchRelationshipsResult
  | AddRelationshipResult
  | RemoveRelationshipResult
  | ReattachResult;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "sync_prisma") {
    const stats = await syncMetaobjectsToPrisma(admin, session.shop);
    return { intent: "sync_prisma", stats } satisfies SyncPrismaResult;
  }

  if (intent === "scan") {
    const detection = await detectBundleMetafieldNamespace(admin);
    const products = await scanProducts(admin);

    const counts: Record<string, number> = {};
    for (const p of products) {
      counts[p.status] = (counts[p.status] ?? 0) + 1;
    }

    const cacheData = {
      products,
      namespaces: detection.namespaces,
      diagnostics: detection.diagnostics,
      counts,
    };

    await writeScanCache(session.shop, cacheData);

    return {
      intent: "scan",
      shopDomain: session.shop,
      ...cacheData,
      scannedAt: new Date().toISOString(),
    } satisfies ScanResult;
  }

  if (intent === "migrate_one") {
    const productJson = formData.get("product") as string;
    const product: ProductMigrationInfo = JSON.parse(
      productJson,
    ) as ProductMigrationInfo;
    const result = await migrateProduct(admin, product, session.shop);

    if (result.success) {
      const refreshed = await rescanSingleProduct(admin, product.gid);
      if (refreshed) {
        await updateProductInCache(session.shop, refreshed);
      }
    }

    return { intent: "migrate_one", result } satisfies MigrateOneResult;
  }

  if (intent === "migrate_selected") {
    const productsJson = formData.get("products") as string;
    const selectedProducts: ProductMigrationInfo[] = JSON.parse(
      productsJson,
    ) as ProductMigrationInfo[];
    const readyProducts = selectedProducts.filter((p) => p.status === "ready");
    const summary = await migrateAllReady(admin, readyProducts, session.shop);

    try {
      await syncMetaobjectsToPrisma(admin, session.shop);
    } catch (e) {
      console.error("[Sync] Post-migration sync failed:", e);
    }

    return { intent: "migrate_all", summary } satisfies MigrateAllResult;
  }

  if (intent === "migrate_all") {
    const detection = await detectBundleMetafieldNamespace(admin);
    void detection;
    const products = await scanProducts(admin);
    const summary = await migrateAllReady(admin, products, session.shop);

    try {
      await syncMetaobjectsToPrisma(admin, session.shop);
    } catch (e) {
      console.error("[Sync] Post-migration sync failed:", e);
    }

    return { intent: "migrate_all", summary } satisfies MigrateAllResult;
  }

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
    return {
      intent: "add_relationship",
      success: true,
    } satisfies AddRelationshipResult;
  }

  if (intent === "remove_relationship") {
    const variantGid = formData.get("variantGid") as string;
    const metaobjectGid = formData.get("metaobjectGid") as string;
    await removeSingleRelationship(admin, variantGid, metaobjectGid);
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

  return { intent: "unknown" };
};

const STATUS_CONFIG: Record<
  ProductMigrationStatus,
  { label: string; color: string; bg: string }
> = {
  ready: { label: "Ready", color: "#2c6ecb", bg: "#f0f6ff" },
  migrated: { label: "Migrated", color: "#008060", bg: "#f0fdf4" },
  ambiguous: { label: "Ambiguous", color: "#b98900", bg: "#fdf8e8" },
  no_base: { label: "No Base", color: "#b98900", bg: "#fdf8e8" },
  missing_data: { label: "Missing Data", color: "#b98900", bg: "#fdf8e8" },
  error: { label: "Error", color: "#d72c0d", bg: "#fdf0f0" },
  skipped: { label: "Skipped", color: "#6d7175", bg: "#f6f6f7" },
};

const PAGE_SIZE = 20;

const ALL_CATEGORIES: ProductCategory[] = [
  "330ml Can",
  "440ml Can",
  "750ml Bottle",
  "375ml Bottle",
  "Poster",
  "Miscellaneous",
];

export default function MigrationPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const revalidator = useRevalidator();
  const prevFetcherData = useRef(fetcher.data);

  useEffect(() => {
    if (fetcher.data === prevFetcherData.current) return;
    prevFetcherData.current = fetcher.data;

    if (
      fetcher.data &&
      "result" in fetcher.data &&
      fetcher.data.result.success
    ) {
      void revalidator.revalidate();
    }
  }, [fetcher.data, revalidator]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [selectedGids, setSelectedGids] = useState<Set<string>>(new Set());
  const [excludedVariants, setExcludedVariants] = useState<
    Record<string, Set<string>>
  >({});
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(
    new Set(),
  );
  const [modalProductGid, setModalProductGid] = useState<string | null>(null);

  const isBusy = fetcher.state !== "idle";

  const actionScan =
    fetcher.data && "products" in fetcher.data ? fetcher.data : null;
  const loaderScan =
    loaderData.intent === "scan" ? (loaderData as unknown as ScanResult) : null;
  const scanData = actionScan ?? loaderScan;

  const shopDomain = loaderData.shopDomain;
  const allProducts = scanData?.products ?? [];
  const namespaces = scanData?.namespaces ?? {};
  const diagnostics = scanData?.diagnostics ?? [];
  const counts = scanData?.counts ?? {};
  const scannedAt = scanData?.scannedAt ?? null;

  const toggleSelectAll = () => {
    setSelectedGids((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const p of selectableFiltered) next.delete(p.gid);
      } else {
        for (const p of selectableFiltered) next.add(p.gid);
      }
      return next;
    });
  };

  const toggleSelect = (gid: string) => {
    setSelectedGids((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  const toggleExpanded = (gid: string) => {
    setExpandedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  const toggleExcludeVariant = useCallback(
    (productGid: string, variantGid: string) => {
      setExcludedVariants((prev) => {
        const productExclusions = new Set(prev[productGid] ?? []);
        if (productExclusions.has(variantGid)) {
          productExclusions.delete(variantGid);
        } else {
          productExclusions.add(variantGid);
        }
        return { ...prev, [productGid]: productExclusions };
      });
    },
    [],
  );

  const getEffectiveProduct = useCallback(
    (product: ProductMigrationInfo): ProductMigrationInfo => {
      const excluded = excludedVariants[product.gid];
      if (!excluded || excluded.size === 0) return product;
      if (product.status !== "ambiguous") return product;

      const remainingVariants = product.variants.filter(
        (v) => !excluded.has(v.gid),
      );
      const baseVariants = remainingVariants.filter(
        (v) => v.bundleBase === true,
      );

      if (baseVariants.length === 1) {
        const baseVariant = baseVariants[0]!;
        const nonBase = remainingVariants.filter(
          (v) => v.gid !== baseVariant.gid && v.bundleBase !== true,
        );
        const missingQuant = nonBase.filter((v) => v.bundleQuant === null);
        if (missingQuant.length > 0) {
          return {
            ...product,
            status: "missing_data",
            baseVariant,
            statusDetail: `Missing bundle_quant on: ${missingQuant.map((v) => `"${v.title}"`).join(", ")}`,
          };
        }
        return {
          ...product,
          status: "ready",
          baseVariant,
          variants: remainingVariants,
          statusDetail: `Ready (${excluded.size} variant${excluded.size !== 1 ? "s" : ""} excluded). Base: "${baseVariant.title}", ${nonBase.length} to configure.`,
        };
      }
      if (baseVariants.length === 0) {
        return {
          ...product,
          status: "no_base",
          baseVariant: null,
          statusDetail: "All base variants excluded",
        };
      }
      return {
        ...product,
        statusDetail: `Multiple base variants remain: ${baseVariants.map((v) => `"${v.title}"`).join(", ")}. Exclude more to resolve.`,
      };
    },
    [excludedVariants],
  );

  const effectiveProducts = allProducts.map(getEffectiveProduct);

  const filtered = effectiveProducts.filter((p) => {
    const matchesSearch =
      !search || p.title.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || p.status === statusFilter;
    const matchesCategory =
      categoryFilter === "all" || p.category === categoryFilter;
    return matchesSearch && matchesStatus && matchesCategory;
  });

  const selectableFiltered = filtered.filter((p) => p.status === "ready");
  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((p) => selectedGids.has(p.gid));

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageProducts = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const readyCount = counts["ready"] ?? 0;

  const handleScan = () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ intent: "scan" }, { method: "POST" });
  };

  const handleMigrateOne = (product: ProductMigrationInfo) => {
    const effective = getEffectiveProduct(product);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "migrate_one", product: JSON.stringify(effective) },
      { method: "POST" },
    );
  };

  const handleMigrateAll = () => {
    if (
      !confirm(
        `Migrate ${readyCount} products? This will create product_relationship metaobjects for each.`,
      )
    ) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ intent: "migrate_all" }, { method: "POST" });
  };

  const handleMigrateSelected = () => {
    const selectedProducts = effectiveProducts.filter(
      (p) => selectedGids.has(p.gid) && p.status === "ready",
    );
    if (selectedProducts.length === 0) return;
    if (
      !confirm(
        `Migrate ${selectedProducts.length} selected product${selectedProducts.length !== 1 ? "s" : ""}?`,
      )
    ) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "migrate_selected",
        products: JSON.stringify(selectedProducts),
      },
      { method: "POST" },
    );
  };

  const handleSyncPrisma = () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ intent: "sync_prisma" }, { method: "POST" });
  };

  const actionResult = fetcher.data;
  const syncResult =
    actionResult && "stats" in actionResult ? actionResult.stats : null;

  return (
    <s-page heading="Bundle Migration">
      <s-section heading="Scan">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Scans all products for <s-text type="strong">bundle_base</s-text> /{" "}
            <s-text type="strong">bundle_quant</s-text> variant metafields and
            classifies their migration status.
          </s-paragraph>

          <s-stack direction="inline" gap="base">
            <s-button onClick={handleScan} disabled={isBusy}>
              {isBusy && !actionScan
                ? "Scanning..."
                : scanData
                  ? "Re-scan Products"
                  : "Scan Products"}
            </s-button>
            {readyCount > 0 && (
              <s-button
                variant="secondary"
                onClick={handleMigrateAll}
                disabled={isBusy}
              >
                {isBusy ? "Migrating..." : `Migrate All Ready (${readyCount})`}
              </s-button>
            )}
            {scannedAt && (
              <s-text tone="neutral">
                Last scanned: {new Date(scannedAt).toLocaleString()}
              </s-text>
            )}
          </s-stack>

          {scanData && (
            <NamespaceBanner
              namespaces={namespaces}
              diagnostics={diagnostics}
            />
          )}

          {scanData && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))",
                gap: "8px",
              }}
            >
              <CountCard
                label="Ready"
                count={counts["ready"] ?? 0}
                color="#2c6ecb"
                onClick={() => {
                  setStatusFilter("ready");
                  setPage(0);
                }}
              />
              <CountCard
                label="Migrated"
                count={counts["migrated"] ?? 0}
                color="#008060"
                onClick={() => {
                  setStatusFilter("migrated");
                  setPage(0);
                }}
              />
              <CountCard
                label="Ambiguous"
                count={counts["ambiguous"] ?? 0}
                color="#b98900"
                onClick={() => {
                  setStatusFilter("ambiguous");
                  setPage(0);
                }}
              />
              <CountCard
                label="No Base"
                count={counts["no_base"] ?? 0}
                color="#b98900"
                onClick={() => {
                  setStatusFilter("no_base");
                  setPage(0);
                }}
              />
              <CountCard
                label="Missing Data"
                count={counts["missing_data"] ?? 0}
                color="#b98900"
                onClick={() => {
                  setStatusFilter("missing_data");
                  setPage(0);
                }}
              />
              <CountCard
                label="Skipped"
                count={counts["skipped"] ?? 0}
                color="#6d7175"
                onClick={() => {
                  setStatusFilter("skipped");
                  setPage(0);
                }}
              />
              <CountCard
                label="Errors"
                count={counts["error"] ?? 0}
                color="#d72c0d"
                onClick={() => {
                  setStatusFilter("error");
                  setPage(0);
                }}
              />
            </div>
          )}

          {actionResult &&
            "summary" in actionResult &&
            actionResult.summary && (
              <ActionResultBanner summary={actionResult.summary} />
            )}

          {actionResult && "result" in actionResult && actionResult.result && (
            <SingleResultBanner result={actionResult.result} />
          )}

          {syncResult && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "8px",
                border: "1px solid #008060",
                backgroundColor: "#f0fdf4",
              }}
            >
              <s-text>
                {"\u2713"} Prisma sync complete: {syncResult.created} created,{" "}
                {syncResult.updated} updated, {syncResult.deleted} deleted (
                {syncResult.total} variant relationships found)
              </s-text>
            </div>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Prisma Sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Syncs <s-text type="strong">product_relationship</s-text>{" "}
            metaobjects from Shopify into the local database used by inventory
            sync and pick lists. Runs automatically every 5 minutes on page
            load.
          </s-paragraph>
          <s-button
            variant="secondary"
            onClick={handleSyncPrisma}
            disabled={isBusy}
          >
            {isBusy ? "Syncing..." : "Sync Now"}
          </s-button>
        </s-stack>
      </s-section>

      {scanData && (
        <s-section heading={`Products (${filtered.length})`}>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <div style={{ flex: 1, minWidth: "200px" }}>
                <s-text-field
                  label="Search products"
                  value={search}
                  placeholder="Filter by product name..."
                  onInput={(e: Event) => {
                    const target = e.target as HTMLInputElement;
                    setSearch(target.value);
                    setPage(0);
                  }}
                />
              </div>
              <div>
                <label
                  htmlFor="status-filter"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    marginBottom: "4px",
                  }}
                >
                  Status filter
                </label>
                <select
                  id="status-filter"
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setPage(0);
                  }}
                  style={{
                    padding: "8px 12px",
                    border: "1px solid var(--p-color-border)",
                    borderRadius: "4px",
                    fontSize: "14px",
                  }}
                >
                  <option value="all">All</option>
                  <option value="ready">Ready</option>
                  <option value="migrated">Migrated</option>
                  <option value="ambiguous">Ambiguous</option>
                  <option value="no_base">No Base</option>
                  <option value="missing_data">Missing Data</option>
                  <option value="skipped">Skipped</option>
                  <option value="error">Error</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="category-filter"
                  style={{
                    display: "block",
                    fontSize: "12px",
                    marginBottom: "4px",
                  }}
                >
                  Category
                </label>
                <select
                  id="category-filter"
                  value={categoryFilter}
                  onChange={(e) => {
                    setCategoryFilter(e.target.value);
                    setPage(0);
                  }}
                  style={{
                    padding: "8px 12px",
                    border: "1px solid var(--p-color-border)",
                    borderRadius: "4px",
                    fontSize: "14px",
                  }}
                >
                  <option value="all">All Categories</option>
                  {ALL_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
            </s-stack>

            {selectedGids.size > 0 && (
              <s-stack direction="inline" gap="base">
                <s-text>
                  {selectedGids.size} product
                  {selectedGids.size !== 1 ? "s" : ""} selected
                </s-text>
                <s-button
                  variant="primary"
                  onClick={handleMigrateSelected}
                  disabled={isBusy}
                >
                  Migrate Selected ({selectedGids.size})
                </s-button>
                <s-button
                  variant="tertiary"
                  onClick={() => setSelectedGids(new Set())}
                >
                  Clear Selection
                </s-button>
              </s-stack>
            )}

            <div style={{ overflowX: "auto" }}>
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
                      borderBottom: "2px solid var(--p-color-border)",
                      textAlign: "left",
                    }}
                  >
                    <th
                      style={{
                        padding: "12px 8px",
                        fontWeight: 600,
                        width: "40px",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAll}
                        title="Select all ready products in current filter"
                      />
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Product
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Category
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Variants
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Base Variant
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Status
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Detail
                    </th>
                    <th
                      style={{
                        padding: "12px 8px",
                        fontWeight: 600,
                        textAlign: "right",
                      }}
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pageProducts.map((product) => {
                    const original =
                      allProducts.find((p) => p.gid === product.gid) ?? product;
                    return (
                      <ProductRow
                        key={product.gid}
                        product={product}
                        originalProduct={original}
                        selected={selectedGids.has(product.gid)}
                        expanded={expandedProducts.has(product.gid)}
                        excludedGids={
                          excludedVariants[product.gid] ?? new Set()
                        }
                        onToggle={() => toggleSelect(product.gid)}
                        onToggleExpand={() => toggleExpanded(product.gid)}
                        onToggleExclude={(vGid) =>
                          toggleExcludeVariant(product.gid, vGid)
                        }
                        onMigrate={handleMigrateOne}
                        onOpenDetail={setModalProductGid}
                        isBusy={isBusy}
                        shopDomain={shopDomain}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <s-stack direction="inline" gap="small">
                <s-button
                  variant="tertiary"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </s-button>
                <s-text>
                  Page {page + 1} of {totalPages}
                </s-text>
                <s-button
                  variant="tertiary"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </s-button>
              </s-stack>
            )}

            <s-text tone="neutral">
              Showing {pageProducts.length} of {filtered.length} products
            </s-text>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="About Migration">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            This page reads <s-text type="strong">bundle_base</s-text> and{" "}
            <s-text type="strong">bundle_quant</s-text> metafields from each
            product&apos;s variants and creates{" "}
            <s-text type="strong">product_relationship</s-text> metaobjects.
          </s-paragraph>
          <s-paragraph>
            For each product with a single base variant, every non-base variant
            gets a metaobject linking it to the base with the correct quantity.
          </s-paragraph>
          <s-paragraph>
            Click a product name to view and manage its relationships directly.
          </s-paragraph>
        </s-stack>
      </s-section>

      {modalProductGid && (
        <ProductDetailModal
          productGid={modalProductGid}
          shopDomain={shopDomain}
          onClose={() => setModalProductGid(null)}
          onChanged={() => {
            void revalidator.revalidate();
          }}
        />
      )}
    </s-page>
  );
}

function NamespaceBanner({
  namespaces,
  diagnostics,
}: {
  namespaces: Record<string, string>;
  diagnostics: MetafieldDiagnostic[];
}) {
  const entries = Object.entries(namespaces);

  if (entries.length === 0 && diagnostics.length === 0) {
    return (
      <div
        style={{
          padding: "12px 16px",
          borderRadius: "8px",
          border: "1px solid #b98900",
          backgroundColor: "#fdf8e8",
        }}
      >
        <s-stack direction="block" gap="small">
          <s-text type="strong">Namespace not detected</s-text>
          <s-text>
            Could not find <code>bundle_base</code> or <code>bundle_quant</code>{" "}
            metafields on any variant in the first 50 variants sampled. Check
            that these metafields exist and are populated.
          </s-text>
        </s-stack>
      </div>
    );
  }

  const isMixed = new Set(entries.map(([, ns]) => ns)).size > 1;

  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "8px",
        border: `1px solid ${isMixed ? "#b98900" : "#008060"}`,
        backgroundColor: isMixed ? "#fdf8e8" : "#f0fdf4",
      }}
    >
      <s-stack direction="block" gap="small">
        {entries.map(([key, ns]) => (
          <s-text key={key}>
            <code>{key}</code>: <code>{ns}</code> namespace
          </s-text>
        ))}
        <s-text>
          {diagnostics.length} metafield sample
          {diagnostics.length !== 1 ? "s" : ""} found
          {isMixed && " (mixed namespaces detected)"}
        </s-text>
      </s-stack>
    </div>
  );
}

function CountCard({
  label,
  count,
  color,
  onClick,
}: {
  label: string;
  count: number;
  color: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "12px 16px",
        borderRadius: "8px",
        border: "1px solid var(--p-color-border-subdued)",
        textAlign: "center",
        background: "white",
        cursor: "pointer",
        transition: "box-shadow 0.15s",
      }}
    >
      <div style={{ fontSize: "24px", fontWeight: 700, color }}>{count}</div>
      <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px" }}>
        {label}
      </div>
    </button>
  );
}

const CATEGORY_COLORS: Record<ProductCategory, { color: string; bg: string }> =
  {
    "330ml Can": { color: "#1f5199", bg: "#e8f0fe" },
    "440ml Can": { color: "#2c6ecb", bg: "#f0f6ff" },
    "750ml Bottle": { color: "#6b21a8", bg: "#f3e8ff" },
    "375ml Bottle": { color: "#9333ea", bg: "#faf5ff" },
    Poster: { color: "#92400e", bg: "#fef3c7" },
    Miscellaneous: { color: "#6d7175", bg: "#f6f6f7" },
  };

function CategoryBadge({ category }: { category: ProductCategory }) {
  const config = CATEGORY_COLORS[category];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "12px",
        fontSize: "12px",
        fontWeight: 600,
        color: config.color,
        backgroundColor: config.bg,
        whiteSpace: "nowrap",
      }}
    >
      {category}
    </span>
  );
}

function StatusBadge({ status }: { status: ProductMigrationStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "12px",
        fontSize: "12px",
        fontWeight: 600,
        color: config.color,
        backgroundColor: config.bg,
        whiteSpace: "nowrap",
      }}
    >
      {config.label}
    </span>
  );
}

function extractShopifyId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function ProductRow({
  product,
  originalProduct,
  selected,
  expanded,
  excludedGids,
  onToggle,
  onToggleExpand,
  onToggleExclude,
  onMigrate,
  onOpenDetail,
  isBusy,
  shopDomain,
}: {
  product: ProductMigrationInfo;
  originalProduct: ProductMigrationInfo;
  selected: boolean;
  expanded: boolean;
  excludedGids: Set<string>;
  onToggle: () => void;
  onToggleExpand: () => void;
  onToggleExclude: (variantGid: string) => void;
  onMigrate: (p: ProductMigrationInfo) => void;
  onOpenDetail: (gid: string) => void;
  isBusy: boolean;
  shopDomain: string;
}) {
  const isSelectable = product.status === "ready";
  const isExpandable =
    originalProduct.status === "ambiguous" ||
    originalProduct.status === "no_base";
  const productId = extractShopifyId(product.gid);
  const adminUrl = `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/products/${productId}`;
  const colCount = 8;

  return (
    <>
      <tr
        style={{
          borderBottom: expanded
            ? "none"
            : "1px solid var(--p-color-border-subdued)",
        }}
      >
        <td style={{ padding: "10px 8px" }}>
          <input
            type="checkbox"
            checked={selected}
            disabled={!isSelectable}
            onChange={onToggle}
          />
        </td>
        <td style={{ padding: "10px 8px" }}>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <button
              type="button"
              onClick={() => onOpenDetail(product.gid)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "#2c6ecb",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "inherit",
                textAlign: "left",
              }}
            >
              {product.title}
            </button>
            <a
              href={adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in Shopify admin"
              style={{ color: "#8c9196", fontSize: "12px", lineHeight: 1 }}
            >
              &#8599;
            </a>
          </span>
        </td>
        <td style={{ padding: "10px 8px" }}>
          <CategoryBadge category={product.category} />
        </td>
        <td style={{ padding: "10px 8px" }}>
          <s-text>{product.variants.length}</s-text>
        </td>
        <td style={{ padding: "10px 8px" }}>
          <s-text>
            {product.baseVariant
              ? `${product.baseVariant.title}${product.baseVariant.sku ? ` (${product.baseVariant.sku})` : ""}`
              : "\u2014"}
          </s-text>
        </td>
        <td style={{ padding: "10px 8px" }}>
          <StatusBadge status={product.status} />
        </td>
        <td style={{ padding: "10px 8px", maxWidth: "300px" }}>
          <s-text tone="neutral">{product.statusDetail}</s-text>
        </td>
        <td style={{ padding: "10px 8px", textAlign: "right" }}>
          <div
            style={{ display: "flex", gap: "4px", justifyContent: "flex-end" }}
          >
            {isExpandable && (
              <s-button variant="tertiary" onClick={onToggleExpand}>
                {expanded ? "Collapse" : "Edit"}
              </s-button>
            )}
            {product.status === "ready" && (
              <s-button
                variant="tertiary"
                onClick={() => onMigrate(product)}
                disabled={isBusy}
              >
                Migrate
              </s-button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
          <td colSpan={colCount} style={{ padding: "0 8px 12px 40px" }}>
            <VariantExclusionPanel
              variants={originalProduct.variants}
              excludedGids={excludedGids}
              onToggleExclude={onToggleExclude}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function VariantExclusionPanel({
  variants,
  excludedGids,
  onToggleExclude,
}: {
  variants: VariantInfo[];
  excludedGids: Set<string>;
  onToggleExclude: (gid: string) => void;
}) {
  return (
    <div
      style={{
        background: "#f9fafb",
        borderRadius: "6px",
        padding: "12px",
        marginTop: "4px",
      }}
    >
      <div style={{ marginBottom: "8px" }}>
        <s-text type="strong">
          Variants — uncheck to exclude from migration:
        </s-text>
      </div>
      <table
        style={{ width: "100%", fontSize: "13px", borderCollapse: "collapse" }}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e0e0e0" }}>
            <th style={{ padding: "6px 8px", fontWeight: 600, width: "40px" }}>
              Include
            </th>
            <th style={{ padding: "6px 8px", fontWeight: 600 }}>Variant</th>
            <th style={{ padding: "6px 8px", fontWeight: 600 }}>SKU</th>
            <th style={{ padding: "6px 8px", fontWeight: 600 }}>Base?</th>
            <th style={{ padding: "6px 8px", fontWeight: 600 }}>Quantity</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => {
            const excluded = excludedGids.has(v.gid);
            return (
              <tr
                key={v.gid}
                style={{
                  borderBottom: "1px solid #eee",
                  opacity: excluded ? 0.5 : 1,
                  textDecoration: excluded ? "line-through" : "none",
                }}
              >
                <td style={{ padding: "6px 8px" }}>
                  <input
                    type="checkbox"
                    checked={!excluded}
                    onChange={() => onToggleExclude(v.gid)}
                  />
                </td>
                <td style={{ padding: "6px 8px" }}>{v.title}</td>
                <td style={{ padding: "6px 8px" }}>{v.sku ?? "\u2014"}</td>
                <td style={{ padding: "6px 8px" }}>
                  {v.bundleBase === true
                    ? "\u2705"
                    : v.bundleBase === false
                      ? "\u274C"
                      : "\u2014"}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  {v.bundleQuant ?? "\u2014"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActionResultBanner({ summary }: { summary: BulkMigrationSummary }) {
  return (
    <div
      style={{
        padding: "16px",
        borderRadius: "8px",
        border: `1px solid ${summary.failed > 0 ? "#d72c0d" : "#008060"}`,
        backgroundColor: summary.failed > 0 ? "#fdf0f0" : "#f0fdf4",
      }}
    >
      <s-stack direction="block" gap="small">
        <s-text type="strong">Bulk Migration Complete</s-text>
        <s-text>
          {"\u2713"} {summary.migrated} migrated &nbsp; {"\u26A0"}{" "}
          {summary.skipped} skipped &nbsp; {"\u2717"} {summary.failed} failed
        </s-text>
        {summary.results
          .filter((r) => !r.success)
          .map((r) => (
            <s-text key={r.productGid} tone="critical">
              {r.productGid}: {r.error}
            </s-text>
          ))}
      </s-stack>
    </div>
  );
}

function SingleResultBanner({ result }: { result: MigrationResult }) {
  return (
    <div
      style={{
        padding: "16px",
        borderRadius: "8px",
        border: `1px solid ${result.success ? "#008060" : "#d72c0d"}`,
        backgroundColor: result.success ? "#f0fdf4" : "#fdf0f0",
      }}
    >
      <s-text>
        {result.success
          ? `\u2713 Migrated \u2014 ${result.relationshipsCreated} relationship${result.relationshipsCreated !== 1 ? "s" : ""} created`
          : `\u2717 Failed: ${result.error}`}
      </s-text>
    </div>
  );
}

interface SelectedVariant {
  id: string;
  title: string;
  product?: { title: string };
}

function ProductDetailModal({
  productGid,
  shopDomain,
  onClose,
  onChanged,
}: {
  productGid: string;
  shopDomain: string;
  onClose: () => void;
  onChanged: () => void;
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

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "fetch_relationships", productGid },
      { method: "POST" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productGid]);

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
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit(
        { intent: "fetch_relationships", productGid },
        { method: "POST" },
      );
      onChanged();
    }

    if ("fixed" in fetcher.data) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit(
        { intent: "fetch_relationships", productGid },
        { method: "POST" },
      );
      onChanged();
    }
  }, [fetcher.data, productGid, onChanged]); // eslint-disable-line react-hooks/exhaustive-deps

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
          width: "min(90vw, 900px)",
          maxHeight: "85vh",
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
                                style={{ padding: "8px 16px", fontWeight: 600 }}
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
