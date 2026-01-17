import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface CsvRow {
  name: string;
  parent_gid: string;
  child_gid: string;
  quantity: number;
  expand_on_pick: boolean;
}

interface ImportResult {
  created: number;
  updated: number;
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
  const csvContent = formData.get("csvContent") as string;

  if (!csvContent) {
    return { error: "No CSV content provided" };
  }

  // Ensure shop exists
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  // Parse CSV
  const lines = csvContent.trim().split("\n");
  const header = lines[0];

  if (!header) {
    return { error: "CSV file is empty" };
  }

  // Validate header
  const expectedHeaders = [
    "name",
    "parent_gid",
    "child_gid",
    "quantity",
    "expand_on_pick",
  ];
  const headers = header.split(",").map((h) => h.trim().toLowerCase());

  const missingHeaders = expectedHeaders.filter((h) => !headers.includes(h));
  if (missingHeaders.length > 0) {
    return { error: `Missing required columns: ${missingHeaders.join(", ")}` };
  }

  // Parse rows
  const rows: CsvRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;

    const values = line.split(",").map((v) => v.trim());

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });

    if (!row.name || !row.parent_gid || !row.child_gid) {
      errors.push(
        `Row ${i + 1}: Missing required fields (name, parent_gid, child_gid)`,
      );
      continue;
    }

    const quantity = parseInt(row.quantity ?? "1", 10);
    if (isNaN(quantity) || quantity < 1) {
      errors.push(`Row ${i + 1}: Invalid quantity "${row.quantity}"`);
      continue;
    }

    rows.push({
      name: row.name,
      parent_gid: row.parent_gid,
      child_gid: row.child_gid,
      quantity,
      expand_on_pick: row.expand_on_pick?.toLowerCase() === "true",
    });
  }

  // Group by parent_gid
  const bundleMap = new Map<
    string,
    {
      name: string;
      expandOnPick: boolean;
      children: Array<{ gid: string; quantity: number }>;
    }
  >();

  for (const row of rows) {
    const existing = bundleMap.get(row.parent_gid);
    if (existing) {
      existing.children.push({ gid: row.child_gid, quantity: row.quantity });
    } else {
      bundleMap.set(row.parent_gid, {
        name: row.name,
        expandOnPick: row.expand_on_pick,
        children: [{ gid: row.child_gid, quantity: row.quantity }],
      });
    }
  }

  // Create or update bundles
  let created = 0;
  let updated = 0;

  for (const [parentGid, bundleData] of bundleMap) {
    try {
      const existing = await db.bundle.findUnique({
        where: {
          shopId_parentGid: { shopId: shop, parentGid },
        },
      });

      if (existing) {
        await db.bundle.update({
          where: { id: existing.id },
          data: {
            name: bundleData.name,
            expandOnPick: bundleData.expandOnPick,
            children: {
              deleteMany: {},
              create: bundleData.children.map((c) => ({
                childGid: c.gid,
                quantity: c.quantity,
              })),
            },
          },
        });
        updated++;
      } else {
        await db.bundle.create({
          data: {
            shopId: shop,
            name: bundleData.name,
            parentGid,
            expandOnPick: bundleData.expandOnPick,
            children: {
              create: bundleData.children.map((c) => ({
                childGid: c.gid,
                quantity: c.quantity,
              })),
            },
          },
        });
        created++;
      }
    } catch (e) {
      errors.push(`Failed to save bundle "${bundleData.name}": ${String(e)}`);
    }
  }

  const result: ImportResult = { created, updated, errors };
  return result;
};

export default function ImportBundles() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [csvContent, setCsvContent] = useState("");
  const [fileName, setFileName] = useState("");

  const isSubmitting = fetcher.state === "submitting";

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (event) => {
      setCsvContent(event.target?.result as string);
    };
    reader.readAsText(file);
  };

  const handleSubmit = () => {
    if (!csvContent) {
      void shopify.toast.show("Please select a CSV file");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ csvContent }, { method: "POST" });
  };

  const hasError = fetcher.data && "error" in fetcher.data;
  const result = !hasError
    ? (fetcher.data as ImportResult | undefined)
    : undefined;

  return (
    <s-page
      heading="Import Bundles"
      back-action={JSON.stringify({ url: "/app/bundles" })}
    >
      <s-button
        slot="primary-action"
        onClick={handleSubmit}
        {...(isSubmitting ? { loading: true } : {})}
        disabled={!csvContent}
      >
        Import
      </s-button>

      {hasError && (
        <s-banner tone="critical" dismissible>
          {(fetcher.data as { error: string }).error}
        </s-banner>
      )}

      {result && (
        <s-banner
          tone={result.errors.length > 0 ? "warning" : "success"}
          dismissible
        >
          <s-heading>Import Complete</s-heading>
          <s-paragraph>
            Created {result.created} bundle{result.created !== 1 ? "s" : ""},{" "}
            updated {result.updated} bundle{result.updated !== 1 ? "s" : ""}.
          </s-paragraph>
          {result.errors.length > 0 && (
            <s-stack direction="block" gap="small">
              <s-text type="strong">
                {result.errors.length} error
                {result.errors.length !== 1 ? "s" : ""}:
              </s-text>
              {result.errors.map((err, i) => (
                <s-text key={i}>{err}</s-text>
              ))}
            </s-stack>
          )}
        </s-banner>
      )}

      <s-section heading="Upload CSV File">
        <s-stack direction="block" gap="base">
          <s-drop-zone accept=".csv,text/csv">
            <s-stack direction="block" gap="base">
              <s-paragraph>Drop CSV file here or click to browse</s-paragraph>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                style={{ marginTop: "8px" }}
                id="csv-upload"
              />
              {fileName && <s-text>Selected: {fileName}</s-text>}
            </s-stack>
          </s-drop-zone>

          {csvContent && (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-heading>Preview (first 500 characters)</s-heading>
              <pre style={{ margin: 0, fontSize: "12px", overflow: "auto" }}>
                {csvContent.substring(0, 500)}
                {csvContent.length > 500 && "..."}
              </pre>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="CSV Format">
        <s-stack direction="block" gap="base">
          <s-paragraph>Required columns:</s-paragraph>
          <s-unordered-list>
            <s-list-item>
              <s-text type="strong">name</s-text> - Bundle name
            </s-list-item>
            <s-list-item>
              <s-text type="strong">parent_gid</s-text> - Parent variant GID
            </s-list-item>
            <s-list-item>
              <s-text type="strong">child_gid</s-text> - Child variant GID
            </s-list-item>
            <s-list-item>
              <s-text type="strong">quantity</s-text> - Child quantity
            </s-list-item>
            <s-list-item>
              <s-text type="strong">expand_on_pick</s-text> - true/false
            </s-list-item>
          </s-unordered-list>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Example CSV">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <pre style={{ margin: 0, fontSize: "11px", whiteSpace: "pre-wrap" }}>
            {`name,parent_gid,child_gid,quantity,expand_on_pick
Lager 24-Pack,gid://shopify/ProductVariant/123,gid://shopify/ProductVariant/456,24,false
Variety Pack,gid://shopify/ProductVariant/789,gid://shopify/ProductVariant/111,1,true
Variety Pack,gid://shopify/ProductVariant/789,gid://shopify/ProductVariant/222,1,true`}
          </pre>
        </s-box>
        <s-paragraph>
          Multiple rows with the same parent_gid create one bundle with multiple
          children.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
