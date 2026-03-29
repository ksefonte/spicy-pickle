import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureMetaobjectSetup } from "../services/metaobject-setup.server";
import { syncIfStale } from "../services/metaobject-sync.server";

const SHOW_MIGRATION_PAGE = true;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Ensure product_relationship metaobject + metafield definitions exist.
  // Idempotent — skips creation if already present.
  try {
    await ensureMetaobjectSetup(admin);
  } catch (error) {
    console.error("[Setup] Metaobject setup failed:", error);
  }

  // Keep Prisma bundle cache in sync with Shopify metaobjects.
  // Skips if last sync was < 5 minutes ago.
  try {
    await syncIfStale(admin, session.shop);
  } catch (error) {
    console.error("[Sync] Metaobject sync failed:", error);
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    showMigration: SHOW_MIGRATION_PAGE,
  };
};

export default function App() {
  const { apiKey, showMigration } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/relationships">Product Relationships</s-link>
        <s-link href="/app/bundles">Bundles</s-link>
        <s-link href="/app/locations">Bin Locations</s-link>
        <s-link href="/app/supplier-skus">Supplier SKUs</s-link>
        <s-link href="/app/picklist">Pick List</s-link>
        {showMigration && <s-link href="/app/admin/migrate">Migration</s-link>}
        <s-link href="/app/admin/config">Configuration</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
