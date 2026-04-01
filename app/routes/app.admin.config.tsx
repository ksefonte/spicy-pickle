import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState, useMemo } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";

  const shopRecord = await db.shop.upsert({
    where: { id: shop },
    update: {},
    create: { id: shop },
  });

  const bundles = await db.bundle.findMany({
    where: {
      shopId: shop,
      ...(search
        ? {
            OR: [
              { parentTitle: { contains: search } },
              { parentSku: { contains: search } },
            ],
          }
        : {}),
    },
    orderBy: { parentTitle: "asc" },
    include: { _count: { select: { children: true } } },
  });

  return { shop: shopRecord, bundles, search };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "toggle_global") {
    const current = await db.shop.findUnique({ where: { id: shop } });
    await db.shop.update({
      where: { id: shop },
      data: { syncEnabled: !(current?.syncEnabled ?? false) },
    });
    return { ok: true };
  }

  if (intent === "toggle_bundle") {
    const bundleId = formData.get("bundleId") as string;
    const bundle = await db.bundle.findUnique({ where: { id: bundleId } });
    if (bundle) {
      await db.bundle.update({
        where: { id: bundleId },
        data: { syncEnabled: !bundle.syncEnabled },
      });
    }
    return { ok: true };
  }

  if (intent === "bulk_enable") {
    const bundleIds: string[] = JSON.parse(
      formData.get("bundleIds") as string,
    ) as string[];
    await db.bundle.updateMany({
      where: { id: { in: bundleIds }, shopId: shop },
      data: { syncEnabled: true },
    });
    return { ok: true };
  }

  if (intent === "bulk_disable") {
    const bundleIds: string[] = JSON.parse(
      formData.get("bundleIds") as string,
    ) as string[];
    await db.bundle.updateMany({
      where: { id: { in: bundleIds }, shopId: shop },
      data: { syncEnabled: false },
    });
    return { ok: true };
  }

  if (intent === "save_picklist_defaults") {
    await db.shop.update({
      where: { id: shop },
      data: {
        picklistUnfulfilled: formData.get("picklistUnfulfilled") === "true",
        picklistPartial: formData.get("picklistPartial") === "true",
        picklistFulfilled: formData.get("picklistFulfilled") === "true",
        picklistShippingOnly: formData.get("picklistShippingOnly") === "true",
        picklistMode: (formData.get("picklistMode") as string) || "standard",
        picklistSortBy: (formData.get("picklistSortBy") as string) || "bin",
        picklistSortDir: (formData.get("picklistSortDir") as string) || "asc",
      },
    });
    return { ok: true };
  }

  return { ok: true };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;
type BundleRow = LoaderData["bundles"][number];

type FilterValue = "all" | "enabled" | "disabled";

function extractProductName(parentTitle: string | null): string {
  if (!parentTitle) return "Unknown Product";
  const idx = parentTitle.lastIndexOf(" - ");
  return idx > 0 ? parentTitle.substring(0, idx) : parentTitle;
}

function extractVariantName(parentTitle: string | null): string {
  if (!parentTitle) return "—";
  const idx = parentTitle.lastIndexOf(" - ");
  return idx > 0 ? parentTitle.substring(idx + 3) : parentTitle;
}

interface ProductGroup {
  productName: string;
  bundles: BundleRow[];
}

export default function SyncConfigPage() {
  const { shop, bundles } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<FilterValue>("all");
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(
    new Set(),
  );
  const [page, setPage] = useState(0);

  const isBusy = fetcher.state !== "idle";

  const filteredBundles = bundles.filter((b: BundleRow) => {
    if (statusFilter === "enabled") return b.syncEnabled;
    if (statusFilter === "disabled") return !b.syncEnabled;
    return true;
  });

  const productGroups = useMemo(() => {
    const groupMap = new Map<string, BundleRow[]>();
    for (const b of filteredBundles) {
      const name = extractProductName(b.parentTitle);
      const arr = groupMap.get(name) ?? [];
      arr.push(b);
      groupMap.set(name, arr);
    }
    const groups: ProductGroup[] = [];
    for (const [productName, groupBundles] of groupMap) {
      groups.push({ productName, bundles: groupBundles });
    }
    return groups.sort((a, b) => a.productName.localeCompare(b.productName));
  }, [filteredBundles]);

  const totalPages = Math.max(1, Math.ceil(productGroups.length / PAGE_SIZE));
  const pagedGroups = productGroups.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );

  const allVisibleSelected =
    filteredBundles.length > 0 &&
    filteredBundles.every((b: BundleRow) => selectedIds.has(b.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const b of filteredBundles) next.delete(b.id);
      } else {
        for (const b of filteredBundles) next.add(b.id);
      }
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectProduct = (group: ProductGroup) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = group.bundles.every((b) => next.has(b.id));
      if (allSelected) {
        for (const b of group.bundles) next.delete(b.id);
      } else {
        for (const b of group.bundles) next.add(b.id);
      }
      return next;
    });
  };

  const toggleExpanded = (productName: string) => {
    setExpandedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(productName)) next.delete(productName);
      else next.add(productName);
      return next;
    });
  };

  const handleToggleGlobal = () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ intent: "toggle_global" }, { method: "POST" });
  };

  const handleToggleBundle = (bundleId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ intent: "toggle_bundle", bundleId }, { method: "POST" });
  };

  const handleBulkEnable = () => {
    const ids = filteredBundles
      .filter((b: BundleRow) => selectedIds.has(b.id))
      .map((b: BundleRow) => b.id);
    if (ids.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "bulk_enable", bundleIds: JSON.stringify(ids) },
      { method: "POST" },
    );
    setSelectedIds(new Set());
  };

  const handleBulkDisable = () => {
    const ids = filteredBundles
      .filter((b: BundleRow) => selectedIds.has(b.id))
      .map((b: BundleRow) => b.id);
    if (ids.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "bulk_disable", bundleIds: JSON.stringify(ids) },
      { method: "POST" },
    );
    setSelectedIds(new Set());
  };

  const handleSearchChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const value = target.value;
    setPage(0);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) {
        next.set("search", value);
      } else {
        next.delete("search");
      }
      return next;
    });
  };

  const selectedCount = filteredBundles.filter((b: BundleRow) =>
    selectedIds.has(b.id),
  ).length;

  return (
    <s-page heading="Configuration">
      {/* ── Pick List Defaults ── */}
      <PickListDefaults shop={shop} isBusy={isBusy} />

      {/* ── Global Sync ── */}
      <s-section heading="Inventory Sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            When enabled, inventory changes to child variants automatically
            update parent bundle availability.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-checkbox
              label="Inventory Sync Service"
              checked={shop.syncEnabled || undefined}
              onChange={handleToggleGlobal}
              disabled={isBusy || undefined}
            />
          </s-stack>
          <s-text tone={shop.syncEnabled ? "success" : "neutral"}>
            Sync is currently{" "}
            <s-text type="strong">
              {shop.syncEnabled ? "enabled" : "disabled"}
            </s-text>{" "}
            for this store.
          </s-text>
        </s-stack>
      </s-section>

      {/* ── Bundle Sync Status ── */}
      <s-section heading="Per-Bundle Sync">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <div style={{ flex: 1, minWidth: "200px" }}>
              <s-text-field
                label="Search bundles"
                value={searchParams.get("search") ?? ""}
                placeholder="Filter by name or SKU..."
                onInput={handleSearchChange}
              />
            </div>
            <div>
              <label
                htmlFor="sync-status-filter"
                style={{
                  display: "block",
                  fontSize: "12px",
                  marginBottom: "4px",
                }}
              >
                Status
              </label>
              <select
                id="sync-status-filter"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as FilterValue);
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
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </s-stack>

          <s-stack direction="inline" gap="base" alignItems="center">
            <s-checkbox
              label={`Select All (${filteredBundles.length})`}
              checked={allVisibleSelected || undefined}
              onChange={toggleSelectAll}
            />
            {selectedCount > 0 && (
              <>
                <s-button
                  variant="primary"
                  onClick={handleBulkEnable}
                  disabled={isBusy || undefined}
                >
                  Enable Selected ({selectedCount})
                </s-button>
                <s-button
                  variant="secondary"
                  onClick={handleBulkDisable}
                  disabled={isBusy || undefined}
                >
                  Disable Selected ({selectedCount})
                </s-button>
              </>
            )}
          </s-stack>

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
                  />
                  <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                    Product / Variant
                  </th>
                  <th style={{ padding: "12px 8px", fontWeight: 600 }}>SKU</th>
                  <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                    Children
                  </th>
                  <th
                    style={{
                      padding: "12px 8px",
                      fontWeight: 600,
                      textAlign: "center",
                    }}
                  >
                    Sync
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedGroups.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        padding: "24px 8px",
                        textAlign: "center",
                        color: "#6d7175",
                      }}
                    >
                      {bundles.length === 0
                        ? "No bundles found. Run a metaobject sync from the Migration page first."
                        : "No bundles match the current filter."}
                    </td>
                  </tr>
                ) : (
                  pagedGroups.map((group) => {
                    const isExpanded = expandedProducts.has(group.productName);
                    const allGroupSelected = group.bundles.every((b) =>
                      selectedIds.has(b.id),
                    );
                    const someGroupSelected =
                      !allGroupSelected &&
                      group.bundles.some((b) => selectedIds.has(b.id));
                    const enabledCount = group.bundles.filter(
                      (b) => b.syncEnabled,
                    ).length;

                    return (
                      <ProductGroupRows
                        key={group.productName}
                        group={group}
                        isExpanded={isExpanded}
                        allSelected={allGroupSelected}
                        someSelected={someGroupSelected}
                        selectedIds={selectedIds}
                        enabledCount={enabledCount}
                        isBusy={isBusy}
                        onToggleExpand={() => toggleExpanded(group.productName)}
                        onToggleSelectProduct={() => toggleSelectProduct(group)}
                        onToggleSelectBundle={toggleSelect}
                        onToggleBundle={handleToggleBundle}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <s-stack
              direction="inline"
              gap="small"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-text tone="neutral">
                Page {page + 1} of {totalPages} ({productGroups.length} product
                {productGroups.length !== 1 ? "s" : ""},{" "}
                {filteredBundles.length} variant
                {filteredBundles.length !== 1 ? "s" : ""})
              </s-text>
              <s-stack direction="inline" gap="small">
                <s-button
                  variant="tertiary"
                  disabled={page === 0 || undefined}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </s-button>
                <s-button
                  variant="tertiary"
                  disabled={page >= totalPages - 1 || undefined}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </s-button>
              </s-stack>
            </s-stack>
          )}

          {totalPages <= 1 && (
            <s-text tone="neutral">
              {productGroups.length} product
              {productGroups.length !== 1 ? "s" : ""} ({filteredBundles.length}{" "}
              variant{filteredBundles.length !== 1 ? "s" : ""})
            </s-text>
          )}
        </s-stack>
      </s-section>

      {/* ── Aside panels ── */}
      <s-section slot="aside" heading="Pick List Defaults">
        <s-paragraph>
          Default order filters and sorting applied when generating pick lists.
          These can be overridden per-run on the{" "}
          <s-link href="/app/picklist">Pick List</s-link> page.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Inventory Sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The global toggle must be enabled for any sync to run. Use
            per-bundle toggles to test sync incrementally — enable a few
            products at a time before switching fully from a third-party bundles
            app.
          </s-paragraph>
          <s-paragraph>
            Expand a product row to see its variants. Use the product-level
            checkbox to toggle all variants at once. &quot;Select All
            Visible&quot; operates across all filtered pages.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

/* ─── Pick List Defaults ─── */

function PickListDefaults({
  shop,
  isBusy,
}: {
  shop: LoaderData["shop"];
  isBusy: boolean;
}) {
  const fetcher = useFetcher();

  const [unfulfilled, setUnfulfilled] = useState(shop.picklistUnfulfilled);
  const [partial, setPartial] = useState(shop.picklistPartial);
  const [fulfilled, setFulfilled] = useState(shop.picklistFulfilled);
  const [shippingOnly, setShippingOnly] = useState(shop.picklistShippingOnly);
  const [mode, setMode] = useState(shop.picklistMode);
  const [sortBy, setSortBy] = useState(shop.picklistSortBy);
  const [sortDir, setSortDir] = useState(shop.picklistSortDir);

  const hasChanges =
    unfulfilled !== shop.picklistUnfulfilled ||
    partial !== shop.picklistPartial ||
    fulfilled !== shop.picklistFulfilled ||
    shippingOnly !== shop.picklistShippingOnly ||
    mode !== shop.picklistMode ||
    sortBy !== shop.picklistSortBy ||
    sortDir !== shop.picklistSortDir;

  const handleSave = () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "save_picklist_defaults",
        picklistUnfulfilled: String(unfulfilled),
        picklistPartial: String(partial),
        picklistFulfilled: String(fulfilled),
        picklistShippingOnly: String(shippingOnly),
        picklistMode: mode,
        picklistSortBy: sortBy,
        picklistSortDir: sortDir,
      },
      { method: "POST" },
    );
  };

  const selectStyle = {
    padding: "8px 12px",
    border: "1px solid var(--p-color-border)",
    borderRadius: "4px",
    fontSize: "14px",
  };

  return (
    <s-section heading="Pick List Defaults">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small">
          <s-text type="strong">Order statuses to include:</s-text>
          <s-stack direction="inline" gap="base">
            <s-checkbox
              label="Unfulfilled"
              checked={unfulfilled || undefined}
              onChange={() => setUnfulfilled(!unfulfilled)}
              disabled={isBusy || undefined}
            />
            <s-checkbox
              label="Partially fulfilled"
              checked={partial || undefined}
              onChange={() => setPartial(!partial)}
              disabled={isBusy || undefined}
            />
            <s-checkbox
              label="Fulfilled"
              checked={fulfilled || undefined}
              onChange={() => setFulfilled(!fulfilled)}
              disabled={isBusy || undefined}
            />
          </s-stack>
        </s-stack>

        <s-checkbox
          label="Requires shipping only"
          checked={shippingOnly || undefined}
          onChange={() => setShippingOnly(!shippingOnly)}
          disabled={isBusy || undefined}
        />

        <s-stack direction="inline" gap="base">
          <div>
            <label
              htmlFor="cfg-picklist-mode"
              style={{
                display: "block",
                fontSize: "12px",
                marginBottom: "4px",
              }}
            >
              Mode
            </label>
            <select
              id="cfg-picklist-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              style={selectStyle}
            >
              <option value="standard">Standard</option>
              <option value="resolved">Base Unit Resolution</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="cfg-picklist-sort"
              style={{
                display: "block",
                fontSize: "12px",
                marginBottom: "4px",
              }}
            >
              Sort by
            </label>
            <select
              id="cfg-picklist-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              style={selectStyle}
            >
              <option value="bin">Bin Location</option>
              <option value="product">Product</option>
              <option value="quantity">Quantity</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="cfg-picklist-dir"
              style={{
                display: "block",
                fontSize: "12px",
                marginBottom: "4px",
              }}
            >
              Direction
            </label>
            <select
              id="cfg-picklist-dir"
              value={sortDir}
              onChange={(e) => setSortDir(e.target.value)}
              style={selectStyle}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </div>
        </s-stack>

        {hasChanges && (
          <s-button onClick={handleSave} disabled={isBusy || undefined}>
            Save Defaults
          </s-button>
        )}
      </s-stack>
    </s-section>
  );
}

/* ─── Product Group Rows ─── */

function ProductGroupRows({
  group,
  isExpanded,
  allSelected,
  someSelected,
  selectedIds,
  enabledCount,
  isBusy,
  onToggleExpand,
  onToggleSelectProduct,
  onToggleSelectBundle,
  onToggleBundle,
}: {
  group: ProductGroup;
  isExpanded: boolean;
  allSelected: boolean;
  someSelected: boolean;
  selectedIds: Set<string>;
  enabledCount: number;
  isBusy: boolean;
  onToggleExpand: () => void;
  onToggleSelectProduct: () => void;
  onToggleSelectBundle: (id: string) => void;
  onToggleBundle: (id: string) => void;
}) {
  return (
    <>
      <tr
        style={{
          borderBottom: "1px solid var(--p-color-border-subdued)",
          backgroundColor: "var(--p-color-bg-surface-secondary, #f6f6f7)",
          cursor: "pointer",
        }}
        onClick={onToggleExpand}
      >
        <td
          style={{ padding: "10px 8px" }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={onToggleSelectProduct}
          />
        </td>
        <td style={{ padding: "10px 8px", fontWeight: 600 }} colSpan={2}>
          <span style={{ marginRight: "6px", fontSize: "10px" }}>
            {isExpanded ? "▼" : "▶"}
          </span>
          {group.productName}
          <span
            style={{
              marginLeft: "8px",
              fontSize: "12px",
              color: "#6d7175",
              fontWeight: 400,
            }}
          >
            {group.bundles.length} variant
            {group.bundles.length !== 1 ? "s" : ""}
          </span>
        </td>
        <td />
        <td
          style={{
            padding: "10px 8px",
            textAlign: "center",
            fontSize: "12px",
            color: "#6d7175",
          }}
        >
          {enabledCount}/{group.bundles.length}
        </td>
      </tr>

      {isExpanded &&
        group.bundles.map((bundle) => (
          <tr
            key={bundle.id}
            style={{
              borderBottom: "1px solid var(--p-color-border-subdued)",
            }}
          >
            <td style={{ padding: "8px 8px 8px 24px" }}>
              <input
                type="checkbox"
                checked={selectedIds.has(bundle.id)}
                onChange={() => onToggleSelectBundle(bundle.id)}
              />
            </td>
            <td style={{ padding: "8px", paddingLeft: "32px" }}>
              {extractVariantName(bundle.parentTitle)}
            </td>
            <td
              style={{
                padding: "8px",
                color: "#6d7175",
                fontFamily: "monospace",
                fontSize: "13px",
              }}
            >
              {bundle.parentSku ?? "—"}
            </td>
            <td style={{ padding: "8px" }}>{bundle._count.children}</td>
            <td
              style={{
                padding: "8px",
                textAlign: "center",
              }}
            >
              <SyncToggle
                enabled={bundle.syncEnabled}
                onToggle={() => onToggleBundle(bundle.id)}
                disabled={isBusy}
              />
            </td>
          </tr>
        ))}
    </>
  );
}

/* ─── Sync Toggle ─── */

function SyncToggle({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 12px",
        borderRadius: "12px",
        border: `1px solid ${enabled ? "#008060" : "#8c9196"}`,
        backgroundColor: enabled ? "#f0fdf4" : "#f6f6f7",
        color: enabled ? "#008060" : "#6d7175",
        fontSize: "12px",
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.15s ease",
      }}
    >
      <span
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          backgroundColor: enabled ? "#008060" : "#8c9196",
        }}
      />
      {enabled ? "Enabled" : "Disabled"}
    </button>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
