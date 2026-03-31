import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureMetaobjectSetup } from "../services/metaobject-setup.server";
import { syncIfStale } from "../services/metaobject-sync.server";

const SHOW_MIGRATION_PAGE = true;

let setupDone = false;

export function shouldRevalidate({
  formAction,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (formAction) return false;
  return defaultShouldRevalidate;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!setupDone) {
    try {
      await ensureMetaobjectSetup(admin);
      setupDone = true;
    } catch (error) {
      console.error("[Setup] Metaobject setup failed:", error);
    }
  }

  // Fire-and-forget: sync runs in the background so it never blocks page load.
  // The staleness check inside syncIfStale prevents unnecessary work.
  syncIfStale(admin, session.shop).catch((error: unknown) => {
    console.error("[Sync] Metaobject sync failed:", error);
  });

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
