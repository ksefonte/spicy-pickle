import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  scanProducts,
  migrateProduct,
  migrateAllReady,
  type ProductMigrationInfo,
  type ProductMigrationStatus,
  type MigrationResult,
  type BulkMigrationSummary,
} from "../services/migration.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const products = await scanProducts(admin);

  const counts = {
    ready: products.filter((p) => p.status === "ready").length,
    migrated: products.filter((p) => p.status === "migrated").length,
    ambiguous: products.filter((p) => p.status === "ambiguous").length,
    noBase: products.filter((p) => p.status === "no_base").length,
    missingData: products.filter((p) => p.status === "missing_data").length,
    error: products.filter((p) => p.status === "error").length,
    skipped: products.filter((p) => p.status === "skipped").length,
  };

  return { products, counts };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "migrate_one") {
    const productJson = formData.get("product") as string;
    const product: ProductMigrationInfo = JSON.parse(
      productJson,
    ) as ProductMigrationInfo;
    const result = await migrateProduct(admin, product);
    return { intent: "migrate_one", result };
  }

  if (intent === "migrate_all") {
    const products = await scanProducts(admin);
    const summary = await migrateAllReady(admin, products);
    return { intent: "migrate_all", summary };
  }

  return { intent: "unknown", error: "Unknown action" };
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

export default function MigrationPage() {
  const { products, counts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{
    intent: string;
    result?: MigrationResult;
    summary?: BulkMigrationSummary;
  }>();

  const isBusy = fetcher.state !== "idle";

  const handleMigrateOne = (product: ProductMigrationInfo) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "migrate_one", product: JSON.stringify(product) },
      { method: "POST" },
    );
  };

  const handleMigrateAll = () => {
    if (
      !confirm(
        `Migrate ${counts.ready} products? This will create product_relationship metaobjects for each.`,
      )
    ) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit({ intent: "migrate_all" }, { method: "POST" });
  };

  const actionResult = fetcher.data;

  return (
    <s-page heading="Bundle Migration">
      <s-section heading="Summary">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Migrates existing <s-text type="strong">bundle_base</s-text> /{" "}
            <s-text type="strong">bundle_quant</s-text> variant metafields into{" "}
            <s-text type="strong">product_relationship</s-text> metaobjects.
          </s-paragraph>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: "12px",
            }}
          >
            <CountCard label="Ready" count={counts.ready} color="#2c6ecb" />
            <CountCard
              label="Migrated"
              count={counts.migrated}
              color="#008060"
            />
            <CountCard
              label="Ambiguous"
              count={counts.ambiguous}
              color="#b98900"
            />
            <CountCard label="No Base" count={counts.noBase} color="#b98900" />
            <CountCard
              label="Missing Data"
              count={counts.missingData}
              color="#b98900"
            />
            <CountCard label="Skipped" count={counts.skipped} color="#6d7175" />
            <CountCard label="Errors" count={counts.error} color="#d72c0d" />
          </div>

          {counts.ready > 0 && (
            <s-stack direction="inline" gap="base">
              <s-button onClick={handleMigrateAll} disabled={isBusy}>
                {isBusy ? "Migrating..." : `Migrate All (${counts.ready})`}
              </s-button>
            </s-stack>
          )}

          {actionResult?.intent === "migrate_all" && actionResult.summary && (
            <ActionResultBanner summary={actionResult.summary} />
          )}

          {actionResult?.intent === "migrate_one" && actionResult.result && (
            <SingleResultBanner result={actionResult.result} />
          )}
        </s-stack>
      </s-section>

      <s-section heading="Products">
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
                <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                  Product
                </th>
                <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                  Variants
                </th>
                <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                  Base Variant
                </th>
                <th style={{ padding: "12px 8px", fontWeight: 600 }}>Status</th>
                <th style={{ padding: "12px 8px", fontWeight: 600 }}>Detail</th>
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
              {products.map((product) => (
                <ProductRow
                  key={product.gid}
                  product={product}
                  onMigrate={handleMigrateOne}
                  isBusy={isBusy}
                />
              ))}
            </tbody>
          </table>
        </div>
        <s-text tone="neutral">
          {products.length} product{products.length !== 1 ? "s" : ""} scanned
        </s-text>
      </s-section>

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
            <s-text type="strong">Ambiguous</s-text> products (multiple base
            variants) and <s-text type="strong">No Base</s-text> products (mixed
            packs) need manual configuration in the Shopify admin.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function CountCard({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "8px",
        border: "1px solid var(--p-color-border-subdued)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "24px", fontWeight: 700, color }}>{count}</div>
      <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px" }}>
        {label}
      </div>
    </div>
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

function ProductRow({
  product,
  onMigrate,
  isBusy,
}: {
  product: ProductMigrationInfo;
  onMigrate: (p: ProductMigrationInfo) => void;
  isBusy: boolean;
}) {
  return (
    <tr style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
      <td style={{ padding: "10px 8px" }}>
        <s-text type="strong">{product.title}</s-text>
      </td>
      <td style={{ padding: "10px 8px" }}>
        <s-text>{product.variants.length}</s-text>
      </td>
      <td style={{ padding: "10px 8px" }}>
        <s-text>
          {product.baseVariant
            ? `${product.baseVariant.title}${product.baseVariant.sku ? ` (${product.baseVariant.sku})` : ""}`
            : "—"}
        </s-text>
      </td>
      <td style={{ padding: "10px 8px" }}>
        <StatusBadge status={product.status} />
      </td>
      <td style={{ padding: "10px 8px", maxWidth: "300px" }}>
        <s-text tone="neutral">{product.statusDetail}</s-text>
      </td>
      <td style={{ padding: "10px 8px", textAlign: "right" }}>
        {product.status === "ready" && (
          <s-button
            variant="tertiary"
            onClick={() => onMigrate(product)}
            disabled={isBusy}
          >
            Migrate
          </s-button>
        )}
      </td>
    </tr>
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
          ✓ {summary.migrated} migrated &nbsp; ⚠ {summary.skipped} skipped
          &nbsp; ✗ {summary.failed} failed
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
          ? `✓ Migrated — ${result.relationshipsCreated} relationship${result.relationshipsCreated !== 1 ? "s" : ""} created`
          : `✗ Failed: ${result.error}`}
      </s-text>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
