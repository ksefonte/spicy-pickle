import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
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
  await authenticate.admin(request);

  // Default to today for date filters
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  return {
    defaultStartDate: thirtyDaysAgo.toISOString().split("T")[0],
    defaultEndDate: today.toISOString().split("T")[0],
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
    const sortBy = (formData.get("sortBy") as SortField) ?? "binLocation";
    const sortDirection =
      (formData.get("sortDirection") as SortDirection) ?? "asc";

    const statuses: ("unfulfilled" | "partially_fulfilled")[] = [];
    if (includeUnfulfilled) statuses.push("unfulfilled");
    if (includePartial) statuses.push("partially_fulfilled");

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
        },
        sortBy,
        sortDirection,
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
  const { defaultStartDate, defaultEndDate } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [includeUnfulfilled, setIncludeUnfulfilled] = useState(true);
  const [includePartial, setIncludePartial] = useState(true);
  const [sortBy, setSortBy] = useState<SortField>("binLocation");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

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
    formData.set("unfulfilled", String(includeUnfulfilled));
    formData.set("partial", String(includePartial));
    formData.set("sortBy", sortBy);
    formData.set("sortDirection", sortDirection);
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
            <s-checkbox
              label="Unfulfilled orders"
              checked={includeUnfulfilled}
              onChange={(e: Event) => {
                const target = e.target as HTMLInputElement;
                setIncludeUnfulfilled(target.checked);
              }}
            />
            <s-checkbox
              label="Partially fulfilled orders"
              checked={includePartial}
              onChange={(e: Event) => {
                const target = e.target as HTMLInputElement;
                setIncludePartial(target.checked);
              }}
            />
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-select
              label="Sort by"
              value={sortBy}
              onChange={(e: Event) => {
                const target = e.target as HTMLSelectElement;
                setSortBy(target.value as SortField);
              }}
            >
              <option value="binLocation">Bin Location</option>
              <option value="product">Product</option>
              <option value="quantity">Quantity</option>
            </s-select>
            <s-select
              label="Direction"
              value={sortDirection}
              onChange={(e: Event) => {
                const target = e.target as HTMLSelectElement;
                setSortDirection(target.value as SortDirection);
              }}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </s-select>
          </s-stack>

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
              <div className="pick-list-table">
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr
                      style={{
                        borderBottom: "2px solid var(--p-border-subdued)",
                      }}
                    >
                      <th style={{ textAlign: "left", padding: "8px" }}>
                        Bin Location
                      </th>
                      <th style={{ textAlign: "left", padding: "8px" }}>
                        Product
                      </th>
                      <th style={{ textAlign: "left", padding: "8px" }}>
                        Variant
                      </th>
                      <th style={{ textAlign: "left", padding: "8px" }}>SKU</th>
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
                          {item.binLocation ?? "—"}
                        </td>
                        <td style={{ padding: "8px" }}>{item.productTitle}</td>
                        <td style={{ padding: "8px" }}>{item.variantTitle}</td>
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
          s-page > *:not(.pick-list-table),
          s-section[slot="aside"],
          s-button {
            display: none !important;
          }
          .pick-list-table {
            font-size: 12pt;
          }
        }
      `}</style>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
