import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useNavigate, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface ParsedRow {
  variantGid: string;
  supplierSku: string;
  supplierSkuQty: number;
  isValid: boolean;
  error?: string;
}

interface ImportResult {
  success: boolean;
  imported: number;
  errors: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const csvData = formData.get("csvData") as string;

  if (!csvData) {
    return { success: false, imported: 0, errors: ["No CSV data provided"] };
  }

  const rows: ParsedRow[] = JSON.parse(csvData);
  const validRows = rows.filter((r) => r.isValid);

  if (validRows.length === 0) {
    return { success: false, imported: 0, errors: ["No valid rows to import"] };
  }

  // Ensure shop exists
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  const errors: string[] = [];
  let imported = 0;

  for (const row of validRows) {
    try {
      await db.supplierSku.upsert({
        where: {
          shopId_variantGid: {
            shopId: shop,
            variantGid: row.variantGid,
          },
        },
        create: {
          shopId: shop,
          variantGid: row.variantGid,
          supplierSku: row.supplierSku,
          supplierSkuQty: row.supplierSkuQty,
        },
        update: {
          supplierSku: row.supplierSku,
          supplierSkuQty: row.supplierSkuQty,
        },
      });
      imported++;
    } catch (error) {
      errors.push(
        `Failed to import row for ${row.variantGid}: ${String(error)}`,
      );
    }
  }

  return { success: true, imported, errors };
};

export default function SupplierSkusImport() {
  const navigate = useNavigate();
  const fetcher = useFetcher<ImportResult>();

  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState("");

  const parseCSV = (content: string) => {
    setParseError("");
    const lines = content.trim().split("\n");

    if (lines.length < 2) {
      setParseError("CSV must have a header row and at least one data row");
      setParsedRows([]);
      return;
    }

    const header = lines[0]?.toLowerCase() || "";
    if (
      !header.includes("variant_gid") ||
      !header.includes("supplier_sku") ||
      !header.includes("supplier_sku_qty")
    ) {
      setParseError(
        "CSV must have columns: variant_gid, supplier_sku, supplier_sku_qty",
      );
      setParsedRows([]);
      return;
    }

    const headerCols = header.split(",").map((c) => c.trim());
    const variantGidIdx = headerCols.indexOf("variant_gid");
    const supplierSkuIdx = headerCols.indexOf("supplier_sku");
    const supplierSkuQtyIdx = headerCols.indexOf("supplier_sku_qty");

    const rows: ParsedRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line?.trim()) continue;

      const cols = line.split(",").map((c) => c.trim());

      const variantGid = cols[variantGidIdx] || "";
      const supplierSku = cols[supplierSkuIdx] || "";
      const supplierSkuQtyStr = cols[supplierSkuQtyIdx] || "";
      const supplierSkuQty = parseFloat(supplierSkuQtyStr);

      let isValid = true;
      let error: string | undefined;

      if (!variantGid.startsWith("gid://shopify/ProductVariant/")) {
        isValid = false;
        error = "Invalid variant GID format";
      } else if (!supplierSku) {
        isValid = false;
        error = "Missing supplier SKU";
      } else if (isNaN(supplierSkuQty) || supplierSkuQty <= 0) {
        isValid = false;
        error = "Invalid quantity (must be > 0)";
      }

      rows.push({
        variantGid,
        supplierSku,
        supplierSkuQty,
        isValid,
        error,
      });
    }

    setParsedRows(rows);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      parseCSV(content);
    };
    reader.readAsText(file);
  };

  const handleSubmit = () => {
    const validRows = parsedRows.filter((r) => r.isValid);
    if (validRows.length === 0) return;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ csvData: JSON.stringify(validRows) }, { method: "POST" });
  };

  const validCount = parsedRows.filter((r) => r.isValid).length;
  const invalidCount = parsedRows.filter((r) => !r.isValid).length;

  const importResult = fetcher.data;

  return (
    <s-page
      heading="Import Supplier SKUs"
      back-action={JSON.stringify({ url: "/app/supplier-skus" })}
    >
      <s-section heading="Upload CSV">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload a CSV file to bulk import supplier SKU mappings. The file
            should have the following columns:
          </s-paragraph>

          <s-box padding="base" background="subdued" borderRadius="base">
            <code style={{ fontFamily: "monospace", fontSize: "13px" }}>
              variant_gid,supplier_sku,supplier_sku_qty
              <br />
              gid://shopify/ProductVariant/123,HD 4X6,0.25
              <br />
              gid://shopify/ProductVariant/456,HD 330ML BOX,0.0833
            </code>
          </s-box>

          <div>
            <label
              htmlFor="csv-upload"
              style={{
                display: "inline-block",
                padding: "10px 16px",
                backgroundColor: "var(--p-color-bg-surface-secondary)",
                border: "1px solid var(--p-color-border)",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              Choose CSV File
            </label>
            <input
              id="csv-upload"
              type="file"
              accept=".csv"
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
          </div>

          {parseError && (
            <s-banner tone="critical" dismissible>
              {parseError}
            </s-banner>
          )}

          {importResult?.success && (
            <s-banner tone="success" dismissible>
              Successfully imported {importResult.imported} supplier SKU
              {importResult.imported !== 1 ? "s" : ""}.
              {importResult.errors.length > 0 && (
                <> {importResult.errors.length} errors occurred.</>
              )}
            </s-banner>
          )}
        </s-stack>
      </s-section>

      {parsedRows.length > 0 && (
        <s-section heading="Preview">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-text>
                <s-text type="strong">{validCount}</s-text> valid rows
              </s-text>
              {invalidCount > 0 && (
                <s-text tone="critical">
                  <s-text type="strong">{invalidCount}</s-text> invalid rows
                </s-text>
              )}
            </s-stack>

            <div style={{ overflowX: "auto", maxHeight: "400px" }}>
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
                      position: "sticky",
                      top: 0,
                      background: "var(--p-color-bg-surface)",
                    }}
                  >
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Status
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Variant GID
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Supplier SKU
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Qty
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Error
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.map((row, idx) => (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: "1px solid var(--p-color-border-subdued)",
                        backgroundColor: row.isValid
                          ? "transparent"
                          : "var(--p-color-bg-surface-critical-subdued)",
                      }}
                    >
                      <td style={{ padding: "10px 8px" }}>
                        {row.isValid ? (
                          <s-text tone="success">✓</s-text>
                        ) : (
                          <s-text tone="critical">✗</s-text>
                        )}
                      </td>
                      <td style={{ padding: "10px 8px", maxWidth: "300px" }}>
                        <s-text>
                          {row.variantGid.replace(
                            "gid://shopify/ProductVariant/",
                            "…/",
                          )}
                        </s-text>
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        <s-text>{row.supplierSku || "—"}</s-text>
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        <s-text>
                          {isNaN(row.supplierSkuQty) ? "—" : row.supplierSkuQty}
                        </s-text>
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        {row.error && (
                          <s-text tone="critical">{row.error}</s-text>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <s-stack direction="inline" gap="base">
              <s-button
                onClick={handleSubmit}
                disabled={validCount === 0 || fetcher.state === "submitting"}
              >
                {fetcher.state === "submitting"
                  ? "Importing..."
                  : `Import ${validCount} Supplier SKU${validCount !== 1 ? "s" : ""}`}
              </s-button>
              <s-button
                variant="secondary"
                onClick={() => navigate("/app/supplier-skus")}
              >
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="CSV Format">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text type="strong">variant_gid:</s-text> The Shopify Product
            Variant GID (e.g., gid://shopify/ProductVariant/12345)
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">supplier_sku:</s-text> Your supplier&apos;s
            SKU code
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">supplier_sku_qty:</s-text> How many of this
            variant equals one supplier SKU (e.g., 0.25 means 4 variants = 1
            supplier SKU)
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
