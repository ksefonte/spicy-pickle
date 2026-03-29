import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

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

  return { ok: true };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;
type BundleRow = LoaderData["bundles"][number];

type FilterValue = "all" | "enabled" | "disabled";

export default function SyncConfigPage() {
  const { shop, bundles } = useLoaderData<LoaderData>();
  const fetcher = useFetcher();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<FilterValue>("all");

  const isBusy = fetcher.state !== "idle";

  const filteredBundles = bundles.filter((b: BundleRow) => {
    if (statusFilter === "enabled") return b.syncEnabled;
    if (statusFilter === "disabled") return !b.syncEnabled;
    return true;
  });

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
    <s-page heading="Sync Configuration">
      <s-section heading="Global Sync">
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

      <s-section heading="Bundle Sync Status">
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
                onChange={(e) => setStatusFilter(e.target.value as FilterValue)}
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

          <s-stack direction="inline" gap="base">
            <s-checkbox
              label="Select All Visible"
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
                    Bundle Name
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
                {filteredBundles.length === 0 ? (
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
                  filteredBundles.map((bundle: BundleRow) => (
                    <tr
                      key={bundle.id}
                      style={{
                        borderBottom: "1px solid var(--p-color-border-subdued)",
                      }}
                    >
                      <td style={{ padding: "10px 8px" }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(bundle.id)}
                          onChange={() => toggleSelect(bundle.id)}
                        />
                      </td>
                      <td style={{ padding: "10px 8px", fontWeight: 500 }}>
                        {bundle.parentTitle ?? "\u2014"}
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          color: "#6d7175",
                          fontFamily: "monospace",
                          fontSize: "13px",
                        }}
                      >
                        {bundle.parentSku ?? "\u2014"}
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        {bundle._count.children}
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          textAlign: "center",
                        }}
                      >
                        <SyncToggle
                          enabled={bundle.syncEnabled}
                          onToggle={() => handleToggleBundle(bundle.id)}
                          disabled={isBusy}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <s-text tone="neutral">
            Showing {filteredBundles.length} of {bundles.length} bundles
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About Sync Configuration">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Control which bundles participate in automatic inventory
            synchronization. When a child variant&apos;s inventory level
            changes, enabled bundles will automatically recalculate the
            parent&apos;s available quantity.
          </s-paragraph>
          <s-paragraph>
            The global toggle must be enabled for any individual bundle sync to
            take effect.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

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
