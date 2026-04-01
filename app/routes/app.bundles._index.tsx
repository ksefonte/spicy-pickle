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

interface VariantInfo {
  title: string;
  sku: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";

  // Ensure shop exists in database
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  // Fetch bundles with children
  const bundles = await db.bundle.findMany({
    where: {
      shopId: shop,
      ...(search
        ? {
            OR: [
              { parentTitle: { contains: search } },
              { parentSku: { contains: search } },
              { parentGid: { contains: search } },
            ],
          }
        : {}),
    },
    include: {
      children: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  // Collect all variant GIDs that need titles fetched
  const allGids = new Set<string>();
  for (const bundle of bundles) {
    if (!bundle.parentTitle) {
      allGids.add(bundle.parentGid);
    }
    for (const child of bundle.children) {
      allGids.add(child.childGid);
    }
  }

  // Fetch variant info from Shopify if needed
  const variantInfoMap = new Map<string, VariantInfo>();
  if (allGids.size > 0) {
    const gidsArray = Array.from(allGids);
    try {
      interface VariantNode {
        id: string;
        title: string;
        sku: string;
        product: { title: string };
      }
      interface NodesResponse {
        nodes: Array<VariantNode | null>;
      }

      const response = await admin.graphql(
        `#graphql
        query GetVariantTitles($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              title
              sku
              product {
                title
              }
            }
          }
        }`,
        { variables: { ids: gidsArray } },
      );

      const data: NodesResponse = (await response.json()).data;
      for (const node of data.nodes) {
        if (node) {
          const displayTitle =
            node.title === "Default Title"
              ? node.product.title
              : `${node.product.title} - ${node.title}`;
          variantInfoMap.set(node.id, {
            title: displayTitle,
            sku: node.sku || "",
          });
        }
      }
    } catch (error) {
      console.error("Failed to fetch variant titles:", error);
    }
  }

  // Build enriched bundles with variant info
  const enrichedBundles = bundles.map((bundle) => {
    const parentInfo = variantInfoMap.get(bundle.parentGid);
    return {
      ...bundle,
      parentTitle: bundle.parentTitle || parentInfo?.title || bundle.parentGid,
      parentSku: bundle.parentSku || parentInfo?.sku || "",
      children: bundle.children.map((child) => {
        const childInfo = variantInfoMap.get(child.childGid);
        return {
          ...child,
          childTitle: childInfo?.title || child.childGid,
          childSku: childInfo?.sku || "",
        };
      }),
    };
  });

  return { bundles: enrichedBundles, shop, search };
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

  if (intent === "updateQuantity") {
    const childId = formData.get("childId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);

    if (isNaN(quantity) || quantity < 1) {
      return { error: "Invalid quantity" };
    }

    await db.bundleChild.update({
      where: { id: childId },
      data: { quantity },
    });

    return { updated: true };
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

  const handleQuantityChange = (childId: string, quantity: number) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "updateQuantity", childId, quantity: quantity.toString() },
      { method: "POST" },
    );
  };

  // Flatten bundles into table rows (one row per child)
  const tableRows: Array<{
    bundleId: string;
    parentTitle: string;
    parentSku: string;
    childId: string;
    childTitle: string;
    childSku: string;
    quantity: number;
    expandOnPick: boolean;
    isFirstChild: boolean;
    childCount: number;
  }> = [];

  for (const bundle of bundles) {
    if (bundle.children.length === 0) {
      // Bundle with no children - show as single row
      tableRows.push({
        bundleId: bundle.id,
        parentTitle: bundle.parentTitle,
        parentSku: bundle.parentSku,
        childId: "",
        childTitle: "(no children)",
        childSku: "",
        quantity: 0,
        expandOnPick: bundle.expandOnPick,
        isFirstChild: true,
        childCount: 0,
      });
    } else {
      bundle.children.forEach((child, index) => {
        tableRows.push({
          bundleId: bundle.id,
          parentTitle: bundle.parentTitle,
          parentSku: bundle.parentSku,
          childId: child.id,
          childTitle: child.childTitle,
          childSku: child.childSku,
          quantity: child.quantity,
          expandOnPick: bundle.expandOnPick,
          isFirstChild: index === 0,
          childCount: bundle.children.length,
        });
      });
    }
  }

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
          <s-stack direction="inline" gap="base">
            <div style={{ flex: 1, minWidth: "200px" }}>
              <s-text-field
                label="Search bundles"
                value={search}
                placeholder="Search by name, SKU, or GID..."
                onInput={(e: Event) => {
                  const target = e.target as HTMLInputElement;
                  handleSearch(target.value);
                }}
              />
            </div>
            <s-stack direction="inline" gap="small">
              <s-button
                variant="secondary"
                onClick={() => navigate("/app/bundles/quick-setup")}
              >
                Quick Setup
              </s-button>
              <s-button
                variant="secondary"
                onClick={() => navigate("/app/bundles/import")}
              >
                Import
              </s-button>
              <s-button
                variant="secondary"
                onClick={() => navigate("/app/bundles/export")}
              >
                Export
              </s-button>
            </s-stack>
          </s-stack>

          {bundles.length === 0 ? (
            <s-box padding="large" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>No bundles configured yet</s-heading>
                <s-paragraph>
                  Create your first bundle to start syncing inventory across
                  product variants.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-button
                    onClick={() => navigate("/app/bundles/quick-setup")}
                  >
                    Quick Setup (recommended)
                  </s-button>
                  <s-button
                    variant="secondary"
                    onClick={() => navigate("/app/bundles/new")}
                  >
                    Manual Setup
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          ) : (
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
                      Parent Name
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Parent SKU
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Child Name
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Child Qty
                    </th>
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
                  {tableRows.map((row, index) => (
                    <tr
                      key={`${row.bundleId}-${row.childId || index}`}
                      style={{
                        borderBottom: "1px solid var(--p-color-border-subdued)",
                        backgroundColor: row.isFirstChild
                          ? "transparent"
                          : "var(--p-color-bg-surface-secondary)",
                      }}
                    >
                      <td style={{ padding: "10px 8px" }}>
                        {row.isFirstChild ? (
                          <s-text type="strong">{row.parentTitle}</s-text>
                        ) : null}
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        {row.isFirstChild ? (
                          <s-text tone="neutral">{row.parentSku || "—"}</s-text>
                        ) : null}
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        <s-text>{row.childTitle}</s-text>
                      </td>
                      <td style={{ padding: "10px 8px", width: "100px" }}>
                        {row.childId ? (
                          <input
                            type="number"
                            min={1}
                            value={row.quantity}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10);
                              if (!isNaN(val) && val >= 1) {
                                handleQuantityChange(row.childId, val);
                              }
                            }}
                            style={{
                              width: "70px",
                              padding: "6px 8px",
                              border: "1px solid var(--p-color-border)",
                              borderRadius: "4px",
                              fontSize: "14px",
                            }}
                          />
                        ) : (
                          <s-text tone="neutral">—</s-text>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "10px 8px",
                          textAlign: "right",
                        }}
                      >
                        {row.isFirstChild ? (
                          <s-stack direction="inline" gap="small">
                            <s-button
                              variant="tertiary"
                              onClick={() =>
                                navigate(`/app/bundles/${row.bundleId}`)
                              }
                            >
                              Edit
                            </s-button>
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              onClick={() =>
                                handleDelete(row.bundleId, row.parentTitle)
                              }
                            >
                              Delete
                            </s-button>
                          </s-stack>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <s-text tone="neutral">
            {bundles.length} bundle{bundles.length !== 1 ? "s" : ""} configured
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About Bundles">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Bundles are the local cache of{" "}
            <s-text type="strong">product_relationship</s-text> metaobjects from
            Shopify. They drive inventory sync and pick list expansion.
          </s-paragraph>
          <s-paragraph>
            To configure relationships, use the{" "}
            <s-link href="/app/relationships">Product Relationships</s-link>{" "}
            page. Changes sync here automatically.
          </s-paragraph>
          <s-paragraph>
            Enable per-bundle sync and pick list expansion on the{" "}
            <s-link href="/app/admin/config">Configuration</s-link> page.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
