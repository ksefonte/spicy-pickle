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
  binsCreated: number;
  variantsAssigned: number;
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
      binsCreated: 0,
      variantsAssigned: 0,
      skipped: 0,
      errors: ["No CSV content provided"],
    } satisfies ImportResult;
  }

  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  const lines = csvContent.trim().split("\n");
  const errors: string[] = [];
  let binsCreated = 0;
  let variantsAssigned = 0;
  let skipped = 0;

  const startIndex = lines[0]?.toLowerCase().includes("variant_gid") ? 1 : 0;

  const maxOrder = await db.bin.aggregate({
    where: { shopId: shop },
    _max: { sortOrder: true },
  });
  let nextSortOrder = (maxOrder._max.sortOrder ?? -1) + 1;

  const binCache = new Map<string, string>();
  const existingBins = await db.bin.findMany({
    where: { shopId: shop },
    select: { id: true, name: true },
  });
  for (const bin of existingBins) {
    binCache.set(bin.name, bin.id);
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const parts = parseCSVLine(line);

    if (parts.length < 2) {
      errors.push(`Line ${i + 1}: Invalid format (need at least 2 columns)`);
      skipped++;
      continue;
    }

    const variantGid = parts[0]?.trim();
    const binName = parts.length >= 3 ? parts[2]?.trim() : parts[1]?.trim();

    if (!variantGid) {
      errors.push(`Line ${i + 1}: Missing variant GID`);
      skipped++;
      continue;
    }

    if (!binName) {
      errors.push(`Line ${i + 1}: Missing bin name`);
      skipped++;
      continue;
    }

    if (!variantGid.startsWith("gid://shopify/ProductVariant/")) {
      errors.push(
        `Line ${i + 1}: Invalid variant GID format (should start with gid://shopify/ProductVariant/)`,
      );
      skipped++;
      continue;
    }

    try {
      let binId = binCache.get(binName);
      if (!binId) {
        const bin = await db.bin.create({
          data: {
            shopId: shop,
            name: binName,
            sortOrder: nextSortOrder++,
          },
        });
        binId = bin.id;
        binCache.set(binName, binId);
        binsCreated++;
      }

      await db.binVariant.deleteMany({
        where: { shopId: shop, variantGid },
      });
      await db.binVariant.create({
        data: { binId, shopId: shop, variantGid },
      });
      variantsAssigned++;
    } catch (error) {
      errors.push(`Line ${i + 1}: Failed to import - ${String(error)}`);
      skipped++;
    }
  }

  return {
    success: errors.length === 0,
    binsCreated,
    variantsAssigned,
    skipped,
    errors: errors.slice(0, 10),
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
            Upload a CSV file with bin locations. Bins will be created
            automatically from unique location names. Variants are assigned to
            their respective bins.
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
            <s-box padding="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small">
                <s-heading>
                  {result.success
                    ? "Import Complete"
                    : "Import Completed with Errors"}
                </s-heading>
                <s-paragraph>
                  Bins created: {result.binsCreated} • Variants assigned:{" "}
                  {result.variantsAssigned} • Skipped: {result.skipped}
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
            <s-text type="strong">Bin creation:</s-text> Unique bin names from
            the CSV will be created as new bins automatically. Existing bins
            with the same name will be reused.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">One bin per variant:</s-text> If a variant
            already has a bin assignment, it will be moved to the new bin from
            the import.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
