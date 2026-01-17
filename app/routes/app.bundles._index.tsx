import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useLoaderData,
  useNavigate,
  useFetcher,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";

  // Ensure shop exists in database
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  // Fetch bundles with child count
  const bundles = await db.bundle.findMany({
    where: {
      shopId: shop,
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { parentGid: { contains: search } },
            ],
          }
        : {}),
    },
    include: {
      _count: {
        select: { children: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return { bundles, shop, search };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const bundleId = formData.get("bundleId") as string;

    await db.bundle.delete({
      where: {
        id: bundleId,
        shopId: shop,
      },
    });

    return { deleted: true };
  }

  return { error: "Unknown action" };
};

export default function BundlesIndex() {
  const { bundles, search } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSearch = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set("search", value);
    } else {
      params.delete("search");
    }
    setSearchParams(params);
  };

  const handleDelete = (bundleId: string, bundleName: string) => {
    if (confirm(`Are you sure you want to delete "${bundleName}"?`)) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit({ intent: "delete", bundleId }, { method: "POST" });
    }
  };

  return (
    <s-page heading="Bundle Configuration">
      <s-button
        slot="primary-action"
        onClick={() => navigate("/app/bundles/new")}
      >
        Create Bundle
      </s-button>

      <s-section heading="Your Bundles">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Search bundles"
            value={search}
            placeholder="Search by name or variant GID..."
            onInput={(e: Event) => {
              const target = e.target as HTMLInputElement;
              handleSearch(target.value);
            }}
          />

          {bundles.length === 0 ? (
            <s-box padding="large" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>No bundles configured yet</s-heading>
                <s-paragraph>
                  Create your first bundle to start syncing inventory across
                  product variants.
                </s-paragraph>
                <s-button onClick={() => navigate("/app/bundles/new")}>
                  Create your first bundle
                </s-button>
              </s-stack>
            </s-box>
          ) : (
            <s-stack direction="block" gap="small">
              {bundles.map((bundle) => (
                <s-box
                  key={bundle.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="small">
                    <s-stack
                      direction="inline"
                      gap="base"
                      justifyContent="space-between"
                    >
                      <s-heading>{bundle.name}</s-heading>
                      <s-stack direction="inline" gap="small">
                        <s-button
                          variant="secondary"
                          onClick={() => navigate(`/app/bundles/${bundle.id}`)}
                        >
                          Edit
                        </s-button>
                        <s-button
                          variant="secondary"
                          tone="critical"
                          onClick={() => handleDelete(bundle.id, bundle.name)}
                        >
                          Delete
                        </s-button>
                      </s-stack>
                    </s-stack>
                    <s-paragraph>
                      {bundle._count.children} component
                      {bundle._count.children !== 1 ? "s" : ""} •{" "}
                      {bundle.expandOnPick
                        ? "Expands on pick"
                        : "Picks as bundle"}
                    </s-paragraph>
                    <s-text tone="neutral">{bundle.parentGid}</s-text>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Import / Export">
        <s-stack direction="block" gap="base">
          <s-paragraph>Bulk manage bundles via CSV files.</s-paragraph>
          <s-button
            variant="secondary"
            onClick={() => navigate("/app/bundles/import")}
          >
            Import CSV
          </s-button>
          <s-button
            variant="secondary"
            onClick={() => navigate("/app/bundles/export")}
          >
            Export CSV
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About Bundles">
        <s-paragraph>
          Bundles link a parent product variant to one or more child variants.
          When inventory changes on any linked variant, all related variants are
          automatically updated.
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Example:</s-text> A 24-Pack variant with
          quantity 24 linked to a Single variant means 48 singles = 2 available
          24-packs.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
