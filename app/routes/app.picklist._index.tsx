import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  generatePickList,
  exportToCSV,
  type PickListResult,
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
      mode: shop.picklistMode as "standard" | "resolved",
      sortBy: shop.picklistSortBy as SortField,
      sortDir: shop.picklistSortDir as SortDirection,
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
    const mode =
      (formData.get("mode") as "standard" | "resolved") ?? "standard";
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

    try {
      const pickList = await generatePickList(
        admin,
        {
          shop,
          startDate: startDateStr ? new Date(startDateStr) : undefined,
          endDate: endDateStr ? new Date(endDateStr) : undefined,
          statuses,
          requiresShipping,
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
  const { defaultStartDate, defaultEndDate, defaults } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [sortBy, setSortBy] = useState<SortField>(defaults.sortBy);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    defaults.sortDir,
  );
  const [mode, setMode] = useState<"standard" | "resolved">(defaults.mode);

  const isLoading =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const pickList = fetcher.data?.pickList;
  const error = fetcher.data?.error;
  const csv = fetcher.data?.csv;

  const handleGenerate = () => {
    const formData = new FormData();
    formData.set("intent", "generate");
    formData.set("startDate", startDate ?? "");
    formData.set("endDate", endDate ?? "");
    formData.set("unfulfilled", String(defaults.unfulfilled));
    formData.set("partial", String(defaults.partial));
    formData.set("fulfilled", String(defaults.fulfilled));
    formData.set("sortBy", sortBy);
    formData.set("sortDirection", sortDirection);
    formData.set("mode", mode);
    formData.set("requiresShipping", String(defaults.shippingOnly));
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(formData, { method: "POST" });
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
                onChange={(e) =>
                  setMode(e.target.value as "standard" | "resolved")
                }
                style={{
                  padding: "8px 12px",
                  border: "1px solid var(--p-color-border)",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                <option value="standard">Standard</option>
                <option value="resolved">Base Unit Resolution</option>
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
                {pickList.mode === "resolved" ? " • Resolved mode" : ""}
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
            Generate a consolidated picking list from your orders. Items are
            aggregated by variant and sorted for efficient warehouse navigation.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Bundle expansion:</s-text> Bundles marked with
            &quot;Expand on pick&quot; will be broken down into their component
            items.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Base Unit Resolution:</s-text> Expands ALL
            bundles to their base components for a fully resolved pick list.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Sorting">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text type="strong">By Bin Location:</s-text> Default. Optimized
            for warehouse picking routes.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">By Product:</s-text> Groups items by product
            name.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">By Quantity:</s-text> Prioritize high-volume
            or low-volume items.
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
