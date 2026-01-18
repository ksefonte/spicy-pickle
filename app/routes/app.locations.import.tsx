import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useNavigate, useFetcher } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  errors: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const csvContent = formData.get("csv") as string;

  if (!csvContent) {
    return {
      success: false,
      imported: 0,
      skipped: 0,
      errors: ["No CSV content provided"],
    } satisfies ImportResult;
  }

  // Ensure shop exists
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  const lines = csvContent.trim().split("\n");
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;

  // Skip header row if present
  const startIndex = lines[0]?.toLowerCase().includes("variant_gid") ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    // Parse CSV line (handle quoted values)
    const parts = parseCSVLine(line);

    if (parts.length < 2) {
      errors.push(`Line ${i + 1}: Invalid format (need at least 2 columns)`);
      skipped++;
      continue;
    }

    const variantGid = parts[0]?.trim();
    // parts[1] is SKU (optional, for reference only)
    const location = parts.length >= 3 ? parts[2]?.trim() : parts[1]?.trim();

    if (!variantGid) {
      errors.push(`Line ${i + 1}: Missing variant GID`);
      skipped++;
      continue;
    }

    if (!location) {
      errors.push(`Line ${i + 1}: Missing bin location`);
      skipped++;
      continue;
    }

    // Validate GID format
    if (!variantGid.startsWith("gid://shopify/ProductVariant/")) {
      errors.push(
        `Line ${i + 1}: Invalid variant GID format (should start with gid://shopify/ProductVariant/)`,
      );
      skipped++;
      continue;
    }

    try {
      await db.binLocation.upsert({
        where: {
          shopId_variantGid: {
            shopId: shop,
            variantGid,
          },
        },
        create: {
          shopId: shop,
          variantGid,
          location,
        },
        update: {
          location,
        },
      });
      imported++;
    } catch (error) {
      errors.push(`Line ${i + 1}: Failed to import - ${String(error)}`);
      skipped++;
    }
  }

  return {
    success: errors.length === 0,
    imported,
    skipped,
    errors: errors.slice(0, 10), // Limit errors to first 10
  } satisfies ImportResult;
};

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);

  return result;
}

export default function LocationsImport() {
  useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<ImportResult>();
  const [csvContent, setCsvContent] = useState("");

  const isSubmitting = fetcher.state === "submitting";
  const result = fetcher.data;

  const handleFileUpload = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === "string") {
        setCsvContent(text);
      }
    };
    reader.readAsText(file);
  };

  const handleSubmit = () => {
    if (!csvContent.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ csv: csvContent }, { method: "POST" });
  };

  return (
    <s-page heading="Import Bin Locations">
      <s-section heading="Upload CSV">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload a CSV file with bin locations. The file should have columns
            for variant GID, SKU (optional), and bin location.
          </s-paragraph>

          <s-box padding="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text type="strong">Expected format:</s-text>
              <code>variant_gid,variant_sku,bin_location</code>
              <s-text tone="neutral">
                Example: gid://shopify/ProductVariant/12345,SKU-001,A-01-03
              </s-text>
            </s-stack>
          </s-box>

          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => handleFileUpload(e as unknown as Event)}
          />

          {csvContent && (
            <s-box padding="base" borderRadius="base" borderWidth="base">
              <s-stack direction="block" gap="small">
                <s-text type="strong">Preview:</s-text>
                <pre
                  style={{
                    maxHeight: "200px",
                    overflow: "auto",
                    fontSize: "12px",
                  }}
                >
                  {csvContent.slice(0, 1000)}
                  {csvContent.length > 1000 ? "\n..." : ""}
                </pre>
              </s-stack>
            </s-box>
          )}

          <s-stack direction="inline" gap="base">
            <s-button
              onClick={handleSubmit}
              disabled={!csvContent.trim() || isSubmitting}
            >
              {isSubmitting ? "Importing..." : "Import Locations"}
            </s-button>
            <s-button
              variant="secondary"
              onClick={() => navigate("/app/locations")}
            >
              Cancel
            </s-button>
          </s-stack>

          {result && (
            <s-box
              padding="base"
              borderRadius="base"
              background={result.success ? "subdued" : "subdued"}
            >
              <s-stack direction="block" gap="small">
                <s-heading>
                  {result.success
                    ? "Import Complete"
                    : "Import Completed with Errors"}
                </s-heading>
                <s-paragraph>
                  Imported: {result.imported} • Skipped: {result.skipped}
                </s-paragraph>
                {result.errors.length > 0 && (
                  <s-stack direction="block" gap="small">
                    <s-text type="strong">Errors:</s-text>
                    {result.errors.map((error, i) => (
                      <s-text key={i} tone="critical">
                        {error}
                      </s-text>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Tips">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text type="strong">Getting Variant GIDs:</s-text> Export your
            products from Shopify Admin to get the variant GIDs, or use the
            Shopify GraphQL API.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Updating locations:</s-text> If a variant
            already has a bin location, importing will update it to the new
            value.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
