import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useNavigate, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { useState, useEffect } from "react";
import { updateBundleMetaobjects } from "../services/metaobject-writes.server";

interface ProductVariant {
  id: string;
  title: string;
  sku: string;
  displayName: string;
}

interface SelectedProduct {
  id: string;
  title: string;
  variants: ProductVariant[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Ensure shop exists
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  return { shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "fetchProduct") {
    // Fetch product variants from Shopify
    const productId = formData.get("productId") as string;

    interface VariantEdge {
      node: {
        id: string;
        title: string;
        sku: string;
      };
    }

    interface ProductResponse {
      product: {
        id: string;
        title: string;
        variants: {
          edges: VariantEdge[];
        };
      } | null;
    }

    const response = await admin.graphql(
      `#graphql
      query GetProductVariants($id: ID!) {
        product(id: $id) {
          id
          title
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
              }
            }
          }
        }
      }`,
      { variables: { id: productId } },
    );

    const data: ProductResponse = (await response.json()).data;

    if (!data.product) {
      return { error: "Product not found" };
    }

    const product: SelectedProduct = {
      id: data.product.id,
      title: data.product.title,
      variants: data.product.variants.edges.map((edge) => ({
        id: edge.node.id,
        title: edge.node.title,
        sku: edge.node.sku || "",
        displayName:
          edge.node.title === "Default Title"
            ? data.product!.title
            : `${data.product!.title} - ${edge.node.title}`,
      })),
    };

    return { product };
  }

  if (intent === "createBundles") {
    // Create bundles from the form data
    const baseVariantId = formData.get("baseVariantId") as string;
    const bundleData = formData.get("bundleData") as string;

    interface BundleConfig {
      parentGid: string;
      parentTitle: string;
      parentSku: string;
      quantity: number;
    }

    const bundles: BundleConfig[] = JSON.parse(bundleData);

    // Get base variant info for caching
    interface VariantNode {
      id: string;
      title: string;
      sku: string;
      product: { title: string };
    }
    interface NodesResponse {
      nodes: Array<VariantNode | null>;
    }

    const variantIds = [baseVariantId, ...bundles.map((b) => b.parentGid)];
    const response = await admin.graphql(
      `#graphql
      query GetVariantInfo($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            sku
            product { title }
          }
        }
      }`,
      { variables: { ids: variantIds } },
    );

    const variantData: NodesResponse = (await response.json()).data;
    const variantMap = new Map<string, { title: string; sku: string }>();
    for (const node of variantData.nodes) {
      if (node) {
        const title =
          node.title === "Default Title"
            ? node.product.title
            : `${node.product.title} - ${node.title}`;
        variantMap.set(node.id, { title, sku: node.sku || "" });
      }
    }

    let createdCount = 0;

    for (const bundleConfig of bundles) {
      if (bundleConfig.quantity < 1) continue;

      const parentInfo = variantMap.get(bundleConfig.parentGid);

      await updateBundleMetaobjects(
        admin,
        shop,
        bundleConfig.parentGid,
        [
          {
            childGid: baseVariantId,
            quantity: bundleConfig.quantity,
          },
        ],
        {
          parentTitle: parentInfo?.title || bundleConfig.parentTitle,
          parentSku: parentInfo?.sku || bundleConfig.parentSku,
          expandOnPick: false,
        },
      );

      createdCount++;
    }

    return { success: true, createdCount };
  }

  return { error: "Unknown action" };
};

export default function BundlesQuickSetup() {
  const navigate = useNavigate();
  const fetcher = useFetcher<{
    product?: SelectedProduct;
    success?: boolean;
    createdCount?: number;
    error?: string;
  }>();

  const [selectedProduct, setSelectedProduct] =
    useState<SelectedProduct | null>(null);
  const [baseVariantId, setBaseVariantId] = useState<string>("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  // Handle fetcher responses
  useEffect(() => {
    if (fetcher.data?.product) {
      setSelectedProduct(fetcher.data.product);
      setBaseVariantId("");
      setQuantities({});
    }
    if (fetcher.data?.success) {
      void navigate("/app/bundles");
    }
  }, [fetcher.data, navigate]);

  const handleProductSelect = () => {
    // Use Shopify Resource Picker
    void shopify
      .resourcePicker({
        type: "product",
        action: "select",
        multiple: false,
      })
      .then((selected) => {
        if (selected && selected.length > 0 && selected[0]) {
          const product = selected[0];
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          fetcher.submit(
            { intent: "fetchProduct", productId: product.id },
            { method: "POST" },
          );
        }
      });
  };

  const handleBaseVariantChange = (variantId: string) => {
    setBaseVariantId(variantId);
    // Reset quantities when base changes
    const newQuantities: Record<string, number> = {};
    if (selectedProduct) {
      for (const variant of selectedProduct.variants) {
        if (variant.id !== variantId) {
          // Try to auto-detect quantity from variant title
          const match = variant.title.match(/(\d+)[\s-]*(pack|pk|x)/i);
          newQuantities[variant.id] = match?.[1] ? parseInt(match[1], 10) : 1;
        }
      }
    }
    setQuantities(newQuantities);
  };

  const handleQuantityChange = (variantId: string, quantity: number) => {
    setQuantities((prev) => ({
      ...prev,
      [variantId]: quantity,
    }));
  };

  const handleSubmit = () => {
    if (!selectedProduct || !baseVariantId) return;

    const bundleData = selectedProduct.variants
      .filter((v) => v.id !== baseVariantId)
      .map((v) => ({
        parentGid: v.id,
        parentTitle: v.displayName,
        parentSku: v.sku,
        quantity: quantities[v.id] || 1,
      }));

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "createBundles",
        baseVariantId,
        bundleData: JSON.stringify(bundleData),
      },
      { method: "POST" },
    );
  };

  const nonBaseVariants =
    selectedProduct?.variants.filter((v) => v.id !== baseVariantId) || [];
  const hasValidQuantities = nonBaseVariants.some(
    (v) => (quantities[v.id] ?? 0) >= 1,
  );

  return (
    <s-page
      heading="Quick Bundle Setup"
      back-action={JSON.stringify({ url: "/app/bundles" })}
    >
      <s-section heading="Step 1: Select a Product">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Choose a product with multiple variants (e.g., Single, 4-Pack,
            6-Pack, 24-Pack). We&apos;ll automatically create bundles linking
            all variants.
          </s-paragraph>

          {selectedProduct ? (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack
                direction="inline"
                gap="base"
                justifyContent="space-between"
              >
                <s-stack direction="block" gap="small">
                  <s-text type="strong">{selectedProduct.title}</s-text>
                  <s-text tone="neutral">
                    {selectedProduct.variants.length} variants
                  </s-text>
                </s-stack>
                <s-button variant="secondary" onClick={handleProductSelect}>
                  Change Product
                </s-button>
              </s-stack>
            </s-box>
          ) : (
            <s-button onClick={handleProductSelect}>Select Product</s-button>
          )}
        </s-stack>
      </s-section>

      {selectedProduct && (
        <s-section heading="Step 2: Select Base Variant">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Choose the &quot;base&quot; variant that all other variants are
              measured in. Usually this is the single/individual unit.
            </s-paragraph>

            <s-stack direction="block" gap="small">
              {selectedProduct.variants.map((variant) => (
                <s-box
                  key={variant.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background={
                    baseVariantId === variant.id ? "subdued" : undefined
                  }
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <input
                      id={`base-variant-${variant.id}`}
                      type="radio"
                      name="baseVariant"
                      checked={baseVariantId === variant.id}
                      onChange={() => handleBaseVariantChange(variant.id)}
                      aria-label={`Select ${variant.displayName} as base variant`}
                    />
                    <s-stack direction="block" gap="small">
                      <s-text type="strong">{variant.displayName}</s-text>
                      {variant.sku && (
                        <s-text tone="neutral">SKU: {variant.sku}</s-text>
                      )}
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {baseVariantId && nonBaseVariants.length > 0 && (
        <s-section heading="Step 3: Set Quantities">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              For each variant, enter how many base units it contains. Set to 0
              to skip creating a bundle for that variant.
            </s-paragraph>

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
                    style={{ borderBottom: "2px solid var(--p-color-border)" }}
                  >
                    <th
                      style={{
                        padding: "12px 8px",
                        textAlign: "left",
                        fontWeight: 600,
                      }}
                    >
                      Variant
                    </th>
                    <th
                      style={{
                        padding: "12px 8px",
                        textAlign: "left",
                        fontWeight: 600,
                      }}
                    >
                      SKU
                    </th>
                    <th
                      style={{
                        padding: "12px 8px",
                        textAlign: "left",
                        fontWeight: 600,
                        width: "150px",
                      }}
                    >
                      Base Units
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {nonBaseVariants.map((variant) => (
                    <tr
                      key={variant.id}
                      style={{
                        borderBottom: "1px solid var(--p-color-border-subdued)",
                      }}
                    >
                      <td style={{ padding: "10px 8px" }}>
                        <s-text>{variant.displayName}</s-text>
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        <s-text tone="neutral">{variant.sku || "—"}</s-text>
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        <input
                          type="number"
                          min={0}
                          value={quantities[variant.id] || ""}
                          placeholder="e.g., 4"
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            handleQuantityChange(
                              variant.id,
                              isNaN(val) ? 0 : val,
                            );
                          }}
                          style={{
                            width: "100px",
                            padding: "8px 12px",
                            border: "1px solid var(--p-color-border)",
                            borderRadius: "4px",
                            fontSize: "14px",
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <s-stack direction="inline" gap="base">
              <s-button
                onClick={handleSubmit}
                disabled={!hasValidQuantities || fetcher.state === "submitting"}
              >
                {fetcher.state === "submitting"
                  ? "Creating Bundles..."
                  : `Create ${nonBaseVariants.filter((v) => (quantities[v.id] ?? 0) >= 1).length} Bundles`}
              </s-button>
              <s-button
                variant="secondary"
                onClick={() => navigate("/app/bundles")}
              >
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="How it Works">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Quick Setup creates one bundle per non-base variant, with the base
            variant as the child component.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Example:</s-text> If you have a product with
            Single, 4-Pack, and 24-Pack variants:
          </s-paragraph>
          <ul style={{ margin: 0, paddingLeft: "20px" }}>
            <li>Select &quot;Single&quot; as the base</li>
            <li>4-Pack → 4 singles</li>
            <li>24-Pack → 24 singles</li>
          </ul>
          <s-paragraph>
            When inventory for Single changes, the availability of 4-Pack and
            24-Pack will automatically update.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
