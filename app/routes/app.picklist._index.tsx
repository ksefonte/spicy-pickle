import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useState, useEffect, useRef } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  generatePickList,
  exportToCSV,
  type PickListResult,
  type PickListMode,
  type SortField,
  type SortDirection,
} from "../services/picklist.server";

interface ActionData {
  pickList?: PickListResult;
  csv?: string;
  error?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.upsert({
    where: { id: session.shop },
    update: {},
    create: { id: session.shop },
  });

  const url = new URL(request.url);

  let preloadedOrderIds: string[] | null = null;

  // Admin link extensions append ids[] params with numeric order IDs
  const idsParams = url.searchParams.getAll("ids[]");
  if (idsParams.length > 0) {
    preloadedOrderIds = idsParams
      .filter(Boolean)
      .map((id) => `gid://shopify/Order/${id}`);
  }

  // Also support comma-separated format from direct URL
  if (!preloadedOrderIds) {
    const ordersParam = url.searchParams.get("orders");
    if (ordersParam) {
      preloadedOrderIds = ordersParam
        .split(",")
        .filter(Boolean)
        .map((id) => `gid://shopify/Order/${id}`);
    }
  }

  if (!preloadedOrderIds) {
    const picklistSessionId = url.searchParams.get("session");
    if (picklistSessionId) {
      const picklistSession = await db.pickListSession.findUnique({
        where: { id: picklistSessionId },
      });
      if (picklistSession && picklistSession.shopId === session.shop) {
        try {
          preloadedOrderIds = JSON.parse(picklistSession.orderIds) as string[];
        } catch {
          // ignore corrupted session
        }
        await db.pickListSession.delete({ where: { id: picklistSessionId } });
      }
    }
  }

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  return {
    defaultStartDate: thirtyDaysAgo.toISOString().split("T")[0],
    defaultEndDate: today.toISOString().split("T")[0],
    defaults: {
      unfulfilled: shop.picklistUnfulfilled,
      partial: shop.picklistPartial,
      fulfilled: shop.picklistFulfilled,
      shippingOnly: shop.picklistShippingOnly,
      mode: shop.picklistMode as PickListMode,
      sortBy: shop.picklistSortBy as SortField,
      sortDir: shop.picklistSortDir as SortDirection,
    },
    preloadedOrderIds,
    autoGenerate: url.searchParams.get("auto") === "true",
    urlOverrides: {
      mode: url.searchParams.get("mode") as PickListMode | null,
      unfulfilled: url.searchParams.get("unfulfilled"),
      partial: url.searchParams.get("partial"),
      fulfilled: url.searchParams.get("fulfilled"),
      shippingOnly: url.searchParams.get("shippingOnly"),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "generate") {
    const startDateStr = formData.get("startDate") as string | null;
    const endDateStr = formData.get("endDate") as string | null;
    const includeUnfulfilled = formData.get("unfulfilled") === "true";
    const includePartial = formData.get("partial") === "true";
    const includeFulfilled = formData.get("fulfilled") === "true";
    const sortBy = (formData.get("sortBy") as SortField) ?? "bin";
    const sortDirection =
      (formData.get("sortDirection") as SortDirection) ?? "asc";
    const mode = (formData.get("mode") as PickListMode) ?? "resolved";
    const requiresShippingStr = formData.get("requiresShipping");
    const requiresShipping =
      requiresShippingStr === "true"
        ? true
        : requiresShippingStr === "false"
          ? false
          : undefined;

    const statuses: ("unfulfilled" | "partially_fulfilled" | "fulfilled")[] =
      [];
    if (includeUnfulfilled) statuses.push("unfulfilled");
    if (includePartial) statuses.push("partially_fulfilled");
    if (includeFulfilled) statuses.push("fulfilled");

    if (statuses.length === 0) {
      return { error: "Please select at least one order status" } as ActionData;
    }

    const orderIdsJson = formData.get("orderIds") as string | null;
    let orderIds: string[] | undefined;
    if (orderIdsJson) {
      try {
        orderIds = JSON.parse(orderIdsJson) as string[];
      } catch {
        // ignore parse error, fall through to date range
      }
    }

    try {
      const pickList = await generatePickList(
        admin,
        {
          shop,
          startDate: orderIds
            ? undefined
            : startDateStr
              ? new Date(startDateStr)
              : undefined,
          endDate: orderIds
            ? undefined
            : endDateStr
              ? new Date(endDateStr)
              : undefined,
          statuses,
          requiresShipping,
          orderIds,
        },
        sortBy,
        sortDirection,
        mode,
      );

      return { pickList } as ActionData;
    } catch (error) {
      console.error("Failed to generate pick list:", error);
      return {
        error: `Failed to generate pick list: ${String(error)}`,
      } as ActionData;
    }
  }

  if (intent === "export") {
    const itemsJson = formData.get("items") as string;
    if (!itemsJson) {
      return { error: "No items to export" } as ActionData;
    }

    try {
      const items = JSON.parse(itemsJson);
      const csv = exportToCSV(items);
      return { csv } as ActionData;
    } catch {
      return { error: "Failed to export CSV" } as ActionData;
    }
  }

  return { error: "Unknown action" } as ActionData;
};

export default function PickListIndex() {
  const {
    defaultStartDate,
    defaultEndDate,
    defaults,
    preloadedOrderIds,
    autoGenerate,
    urlOverrides,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [sortBy, setSortBy] = useState<SortField>(defaults.sortBy);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    defaults.sortDir,
  );
  const [mode, setMode] = useState<PickListMode>(defaults.mode);
  const [orderIdsFromExtension] = useState<string[] | null>(
    preloadedOrderIds ?? null,
  );
  const autoTriggered = useRef(false);

  const isLoading =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const pickList = fetcher.data?.pickList;
  const error = fetcher.data?.error;
  const csv = fetcher.data?.csv;

  const submitGenerate = (
    orderIds?: string[] | null,
    overrides?: typeof urlOverrides,
  ) => {
    const useUnfulfilled =
      overrides?.unfulfilled != null
        ? overrides.unfulfilled === "true"
        : defaults.unfulfilled;
    const usePartial =
      overrides?.partial != null
        ? overrides.partial === "true"
        : defaults.partial;
    const useFulfilled =
      overrides?.fulfilled != null
        ? overrides.fulfilled === "true"
        : defaults.fulfilled;
    const useShipping =
      overrides?.shippingOnly != null
        ? overrides.shippingOnly === "true"
        : defaults.shippingOnly;
    const useMode = overrides?.mode ?? mode;

    const formData = new FormData();
    formData.set("intent", "generate");
    formData.set("startDate", startDate ?? "");
    formData.set("endDate", endDate ?? "");
    formData.set("unfulfilled", String(useUnfulfilled));
    formData.set("partial", String(usePartial));
    formData.set("fulfilled", String(useFulfilled));
    formData.set("sortBy", sortBy);
    formData.set("sortDirection", sortDirection);
    formData.set("mode", useMode);
    formData.set("requiresShipping", String(useShipping));
    if (orderIds && orderIds.length > 0) {
      formData.set("orderIds", JSON.stringify(orderIds));
    }
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(formData, { method: "POST" });
  };

  useEffect(() => {
    if (autoTriggered.current) return;
    if (orderIdsFromExtension && orderIdsFromExtension.length > 0) {
      autoTriggered.current = true;
      submitGenerate(orderIdsFromExtension, urlOverrides);
      const params = new URLSearchParams(searchParams);
      params.delete("session");
      params.delete("orders");
      params.delete("ids[]");
      setSearchParams(params, { replace: true });
    } else if (autoGenerate) {
      autoTriggered.current = true;
      submitGenerate(null, urlOverrides);
      const params = new URLSearchParams(searchParams);
      params.delete("auto");
      params.delete("mode");
      params.delete("unfulfilled");
      params.delete("partial");
      params.delete("fulfilled");
      params.delete("shippingOnly");
      setSearchParams(params, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerate = () => {
    submitGenerate(orderIdsFromExtension);
  };

  const handleExport = () => {
    if (!pickList) return;
    const formData = new FormData();
    formData.set("intent", "export");
    formData.set("items", JSON.stringify(pickList.items));
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(formData, { method: "POST" });
  };

  const handlePrint = () => {
    window.print();
  };

  // Download CSV when it's ready
  if (csv) {
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pick-list-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const activeFilters: string[] = [];
  if (defaults.unfulfilled) activeFilters.push("Unfulfilled");
  if (defaults.partial) activeFilters.push("Partially fulfilled");
  if (defaults.fulfilled) activeFilters.push("Fulfilled");
  if (defaults.shippingOnly) activeFilters.push("Shipping only");

  return (
    <s-page heading="Pick List Generator">
      <s-section heading="Filters">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <div>
              <label
                htmlFor="startDate"
                style={{ display: "block", marginBottom: "4px" }}
              >
                Start Date
              </label>
              <input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={{
                  padding: "8px",
                  borderRadius: "4px",
                  border: "1px solid #ccc",
                }}
              />
            </div>
            <div>
              <label
                htmlFor="endDate"
                style={{ display: "block", marginBottom: "4px" }}
              >
                End Date
              </label>
              <input
                id="endDate"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={{
                  padding: "8px",
                  borderRadius: "4px",
                  border: "1px solid #ccc",
                }}
              />
            </div>
          </s-stack>

          <s-stack direction="inline" gap="base">
            <div>
              <label
                htmlFor="picklist-mode"
                style={{
                  display: "block",
                  fontSize: "12px",
                  marginBottom: "4px",
                }}
              >
                Mode
              </label>
              <select
                id="picklist-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as PickListMode)}
                style={{
                  padding: "8px 12px",
                  border: "1px solid var(--p-color-border)",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                <option value="resolved">Resolved</option>
                <option value="no-expand">No Expand</option>
                <option value="configured">Expand Configured-only</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="picklist-sort"
                style={{
                  display: "block",
                  fontSize: "12px",
                  marginBottom: "4px",
                }}
              >
                Sort by
              </label>
              <select
                id="picklist-sort"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortField)}
                style={{
                  padding: "8px 12px",
                  border: "1px solid var(--p-color-border)",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                <option value="bin">Bin Location</option>
                <option value="product">Product</option>
                <option value="quantity">Quantity</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="picklist-direction"
                style={{
                  display: "block",
                  fontSize: "12px",
                  marginBottom: "4px",
                }}
              >
                Direction
              </label>
              <select
                id="picklist-direction"
                value={sortDirection}
                onChange={(e) =>
                  setSortDirection(e.target.value as SortDirection)
                }
                style={{
                  padding: "8px 12px",
                  border: "1px solid var(--p-color-border)",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          </s-stack>

          <s-text tone="neutral">
            Filters: {activeFilters.join(", ") || "None"} —{" "}
            <a
              href="/app/admin/config"
              style={{ color: "var(--p-color-text-interactive, #2c6ecb)" }}
            >
              Change defaults
            </a>
          </s-text>

          {orderIdsFromExtension && orderIdsFromExtension.length > 0 && (
            <s-box padding="base" borderRadius="base" background="subdued">
              <s-text>
                Generating from{" "}
                <strong>
                  {orderIdsFromExtension.length} selected order
                  {orderIdsFromExtension.length !== 1 ? "s" : ""}
                </strong>{" "}
                (via Shopify Orders page).
              </s-text>
            </s-box>
          )}

          <s-button onClick={handleGenerate} disabled={isLoading}>
            {isLoading ? "Generating..." : "Generate Pick List"}
          </s-button>

          {error && (
            <s-box padding="base" borderRadius="base" background="subdued">
              <s-text tone="critical">{error}</s-text>
            </s-box>
          )}
        </s-stack>
      </s-section>

      {pickList && (
        <s-section heading="Pick List">
          <s-stack direction="block" gap="base">
            <s-stack
              direction="inline"
              gap="base"
              justifyContent="space-between"
            >
              <s-paragraph>
                {pickList.orderCount} order
                {pickList.orderCount !== 1 ? "s" : ""} • {pickList.items.length}{" "}
                unique item
                {pickList.items.length !== 1 ? "s" : ""} • {pickList.totalItems}{" "}
                total units
                {pickList.mode !== "resolved"
                  ? ` • ${pickList.mode === "no-expand" ? "No Expand" : "Configured-only"}`
                  : ""}
              </s-paragraph>
              <s-stack direction="inline" gap="small">
                <s-button variant="secondary" onClick={handleExport}>
                  Export CSV
                </s-button>
                <s-button variant="secondary" onClick={handlePrint}>
                  Print
                </s-button>
              </s-stack>
            </s-stack>

            {pickList.items.length === 0 ? (
              <s-box padding="large" borderRadius="base" background="subdued">
                <s-paragraph>
                  No items found matching your filters. Try adjusting the date
                  range or order status filters.
                </s-paragraph>
              </s-box>
            ) : (
              <div className="pick-list-print-area">
                <div className="pick-list-table">
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr
                        style={{
                          borderBottom: "2px solid var(--p-border-subdued)",
                        }}
                      >
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Bin
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Product
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Variant
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          SKU
                        </th>
                        <th style={{ textAlign: "right", padding: "8px" }}>
                          Avail
                        </th>
                        <th style={{ textAlign: "right", padding: "8px" }}>
                          Quantity
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pickList.items.map((item, index) => (
                        <tr
                          key={`${item.variantGid}-${index}`}
                          style={{
                            borderBottom: "1px solid var(--p-border-subdued)",
                          }}
                        >
                          <td
                            style={{
                              padding: "8px",
                              fontWeight: "bold",
                              fontFamily: "monospace",
                            }}
                          >
                            {item.binName ?? "—"}
                          </td>
                          <td style={{ padding: "8px" }}>
                            {item.productTitle}
                          </td>
                          <td style={{ padding: "8px" }}>
                            {item.variantTitle}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              fontFamily: "monospace",
                              color: "var(--p-text-subdued)",
                            }}
                          >
                            {item.sku ?? "—"}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              color: "var(--p-text-subdued)",
                            }}
                          >
                            {item.available ?? "—"}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              fontWeight: "bold",
                            }}
                          >
                            {item.quantity}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {pickList.orders.length > 0 && (
                  <div className="order-manifest" style={{ marginTop: "24px" }}>
                    <h3 style={{ marginBottom: "12px" }}>
                      Order Manifest ({pickList.orders.length} order
                      {pickList.orders.length !== 1 ? "s" : ""})
                    </h3>
                    <pre
                      style={{
                        fontFamily: "monospace",
                        fontSize: "12px",
                        whiteSpace: "pre-wrap",
                        lineHeight: "1.5",
                      }}
                    >
                      {pickList.orders
                        .map(
                          (order) =>
                            `${order.name}:\n${order.lineItems
                              .map(
                                (li) => `  ${li.quantity}× ${li.description}`,
                              )
                              .join("\n")}`,
                        )
                        .join("\n\n")}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="About Pick Lists">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Generates a consolidated picking list from outstanding orders. Items
            are aggregated by variant, sorted by bin location, and include
            available inventory counts.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Resolved</s-text> (default): Expands all
            bundles with children to their base unit components.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">No Expand:</s-text> Every variant appears
            exactly as ordered — no bundle expansion.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Expand Configured-only:</s-text> Only expands
            bundles that have &quot;expand on pick&quot; enabled. All other
            variants appear as-is.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Configuration">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Order filters (unfulfilled, partial, fulfilled, shipping) and
            default sort/mode settings are managed on the{" "}
            <s-link href="/app/admin/config">Configuration</s-link> page.
          </s-paragraph>
          <s-paragraph>
            Bin locations determine sort order. Manage bins on the{" "}
            <s-link href="/app/locations">Bin Locations</s-link> page.
          </s-paragraph>
        </s-stack>
      </s-section>

      <style>{`
        @media print {
          s-page > *:not(.pick-list-print-area),
          s-section[slot="aside"],
          s-button {
            display: none !important;
          }
          .pick-list-print-area {
            font-size: 12pt;
          }
          .pick-list-table {
            page-break-after: auto;
          }
          .order-manifest {
            page-break-before: auto;
          }
        }
      `}</style>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
