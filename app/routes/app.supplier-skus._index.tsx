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
import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

interface VariantInfo {
  title: string;
  sku: string;
}

interface SelectedVariant {
  id: string;
  title: string;
  sku?: string;
  product?: {
    title: string;
  };
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

  // Fetch supplier SKUs
  const supplierSkus = await db.supplierSku.findMany({
    where: {
      shopId: shop,
      ...(search
        ? {
            OR: [
              { supplierSku: { contains: search } },
              { variantGid: { contains: search } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
  });

  // Fetch variant info from Shopify
  const variantInfoMap = new Map<string, VariantInfo>();
  const variantGids = supplierSkus.map((s) => s.variantGid);

  if (variantGids.length > 0) {
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
              product { title }
            }
          }
        }`,
        { variables: { ids: variantGids } },
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

  // Enrich supplier SKUs with variant info
  const enrichedSupplierSkus = supplierSkus.map((s) => {
    const variantInfo = variantInfoMap.get(s.variantGid);
    return {
      ...s,
      variantTitle: variantInfo?.title || s.variantGid,
      variantSku: variantInfo?.sku || "",
    };
  });

  return { supplierSkus: enrichedSupplierSkus, shop, search };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const supplierSkuId = formData.get("supplierSkuId") as string;

    await db.supplierSku.delete({
      where: {
        id: supplierSkuId,
        shopId: shop,
      },
    });

    return { deleted: true };
  }

  if (intent === "create") {
    const variantGid = formData.get("variantGid") as string;
    const supplierSku = formData.get("supplierSku") as string;
    const supplierSkuQty = parseFloat(formData.get("supplierSkuQty") as string);

    if (!variantGid || !supplierSku || isNaN(supplierSkuQty)) {
      return { error: "Missing required fields" };
    }

    await db.supplierSku.upsert({
      where: {
        shopId_variantGid: {
          shopId: shop,
          variantGid,
        },
      },
      create: {
        shopId: shop,
        variantGid,
        supplierSku,
        supplierSkuQty,
      },
      update: {
        supplierSku,
        supplierSkuQty,
      },
    });

    return { created: true };
  }

  if (intent === "update") {
    const supplierSkuId = formData.get("supplierSkuId") as string;
    const supplierSku = formData.get("supplierSku") as string;
    const supplierSkuQty = parseFloat(formData.get("supplierSkuQty") as string);

    if (!supplierSkuId || !supplierSku || isNaN(supplierSkuQty)) {
      return { error: "Missing required fields" };
    }

    await db.supplierSku.update({
      where: {
        id: supplierSkuId,
        shopId: shop,
      },
      data: {
        supplierSku,
        supplierSkuQty,
      },
    });

    return { updated: true };
  }

  return { error: "Unknown action" };
};

export default function SupplierSkusIndex() {
  const { supplierSkus, search } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();

  const [showAddForm, setShowAddForm] = useState(false);
  const [newVariant, setNewVariant] = useState<SelectedVariant | null>(null);
  const [newSupplierSku, setNewSupplierSku] = useState("");
  const [newSupplierSkuQty, setNewSupplierSkuQty] = useState("1");

  const handleSearch = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set("search", value);
    } else {
      params.delete("search");
    }
    setSearchParams(params);
  };

  const handleDelete = (id: string, supplierSku: string) => {
    if (
      confirm(`Are you sure you want to delete supplier SKU "${supplierSku}"?`)
    ) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit(
        { intent: "delete", supplierSkuId: id },
        { method: "POST" },
      );
    }
  };

  const openVariantPicker = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
      filter: { variants: true },
    });
    const product = selected?.[0];
    const variant = product?.variants?.[0];
    if (variant?.id && product) {
      setNewVariant({
        id: variant.id,
        title: variant.title ?? "Default Title",
        sku: variant.sku ?? undefined,
        product: { title: product.title },
      });
    }
  };

  const getDisplayTitle = (variant: SelectedVariant): string => {
    const productTitle = variant.product?.title ?? "Unknown Product";
    return variant.title === "Default Title"
      ? productTitle
      : `${productTitle} - ${variant.title}`;
  };

  const handleAddSubmit = () => {
    if (!newVariant || !newSupplierSku) {
      void shopify.toast.show("Please fill in all fields", { isError: true });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "create",
        variantGid: newVariant.id,
        supplierSku: newSupplierSku,
        supplierSkuQty: newSupplierSkuQty,
      },
      { method: "POST" },
    );

    // Reset form
    setShowAddForm(false);
    setNewVariant(null);
    setNewSupplierSku("");
    setNewSupplierSkuQty("1");
  };

  const handleInlineUpdate = (
    id: string,
    supplierSku: string,
    supplierSkuQty: string,
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "update",
        supplierSkuId: id,
        supplierSku,
        supplierSkuQty,
      },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Supplier SKUs">
      <s-button slot="primary-action" onClick={() => setShowAddForm(true)}>
        Add Supplier SKU
      </s-button>

      <s-section heading="Supplier SKU Mappings">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <div style={{ flex: 1, minWidth: "200px" }}>
              <s-text-field
                label="Search"
                value={search}
                placeholder="Search by supplier SKU or variant GID..."
                onInput={(e: Event) => {
                  const target = e.target as HTMLInputElement;
                  handleSearch(target.value);
                }}
              />
            </div>
            <s-button
              variant="secondary"
              onClick={() => navigate("/app/supplier-skus/import")}
            >
              Import CSV
            </s-button>
          </s-stack>

          {showAddForm && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>Add Supplier SKU</s-heading>

                {newVariant ? (
                  <s-box
                    padding="base"
                    background="subdued"
                    borderRadius="base"
                  >
                    <s-stack
                      direction="inline"
                      gap="base"
                      justifyContent="space-between"
                    >
                      <s-stack direction="block" gap="small">
                        <s-text type="strong">
                          {getDisplayTitle(newVariant)}
                        </s-text>
                        {newVariant.sku && (
                          <s-text tone="neutral">SKU: {newVariant.sku}</s-text>
                        )}
                      </s-stack>
                      <s-button variant="secondary" onClick={openVariantPicker}>
                        Change
                      </s-button>
                    </s-stack>
                  </s-box>
                ) : (
                  <s-button onClick={openVariantPicker}>
                    Select Variant
                  </s-button>
                )}

                <s-stack direction="inline" gap="base">
                  <div style={{ flex: 1, minWidth: "200px" }}>
                    <s-text-field
                      label="Supplier SKU"
                      value={newSupplierSku}
                      placeholder="e.g., HD 4X6"
                      onInput={(e: Event) => {
                        const target = e.target as HTMLInputElement;
                        setNewSupplierSku(target.value);
                      }}
                    />
                  </div>
                  <div style={{ width: "150px" }}>
                    <s-text-field
                      label="Qty per Supplier SKU"
                      value={newSupplierSkuQty}
                      placeholder="e.g., 0.25"
                      onInput={(e: Event) => {
                        const target = e.target as HTMLInputElement;
                        setNewSupplierSkuQty(target.value);
                      }}
                    />
                  </div>
                </s-stack>

                <s-stack direction="inline" gap="base">
                  <s-button onClick={handleAddSubmit}>Add</s-button>
                  <s-button
                    variant="secondary"
                    onClick={() => setShowAddForm(false)}
                  >
                    Cancel
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          )}

          {supplierSkus.length === 0 ? (
            <s-box padding="large" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>No supplier SKUs configured</s-heading>
                <s-paragraph>
                  Map your Shopify variants to supplier SKUs for inventory cost
                  tracking and reconciliation.
                </s-paragraph>
                <s-button onClick={() => setShowAddForm(true)}>
                  Add your first supplier SKU
                </s-button>
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
                      Variant Name
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Variant SKU
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Supplier SKU
                    </th>
                    <th style={{ padding: "12px 8px", fontWeight: 600 }}>
                      Qty per Supplier SKU
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
                  {supplierSkus.map((sku) => (
                    <SupplierSkuRow
                      key={sku.id}
                      supplierSkuItem={sku}
                      onDelete={handleDelete}
                      onUpdate={handleInlineUpdate}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <s-text tone="neutral">
            {supplierSkus.length} supplier SKU
            {supplierSkus.length !== 1 ? "s" : ""} configured
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About Supplier SKUs">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Supplier SKUs map your Shopify variants to your supplier&apos;s SKU
            codes, allowing you to track inventory costs and reconcile with
            supplier invoices.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Qty per Supplier SKU:</s-text> How many of
            this Shopify variant equals one supplier SKU. For example, if you
            buy 6-packs as &quot;HD 4X6&quot; (a case of 4 six-packs), each
            6-pack is 0.25 of the supplier SKU.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

interface SupplierSkuRowProps {
  supplierSkuItem: {
    id: string;
    variantTitle: string;
    variantSku: string;
    supplierSku: string;
    supplierSkuQty: number;
  };
  onDelete: (id: string, supplierSku: string) => void;
  onUpdate: (id: string, supplierSku: string, supplierSkuQty: string) => void;
}

function SupplierSkuRow({
  supplierSkuItem,
  onDelete,
  onUpdate,
}: SupplierSkuRowProps) {
  const [editing, setEditing] = useState(false);
  const [editSupplierSku, setEditSupplierSku] = useState(
    supplierSkuItem.supplierSku,
  );
  const [editQty, setEditQty] = useState(
    String(supplierSkuItem.supplierSkuQty),
  );

  const handleSave = () => {
    onUpdate(supplierSkuItem.id, editSupplierSku, editQty);
    setEditing(false);
  };

  return (
    <tr
      style={{
        borderBottom: "1px solid var(--p-color-border-subdued)",
      }}
    >
      <td style={{ padding: "10px 8px" }}>
        <s-text>{supplierSkuItem.variantTitle}</s-text>
      </td>
      <td style={{ padding: "10px 8px" }}>
        <s-text tone="neutral">{supplierSkuItem.variantSku || "—"}</s-text>
      </td>
      <td style={{ padding: "10px 8px" }}>
        {editing ? (
          <input
            type="text"
            value={editSupplierSku}
            onChange={(e) => setEditSupplierSku(e.target.value)}
            style={{
              width: "120px",
              padding: "6px 8px",
              border: "1px solid var(--p-color-border)",
              borderRadius: "4px",
              fontSize: "14px",
            }}
          />
        ) : (
          <s-text>{supplierSkuItem.supplierSku}</s-text>
        )}
      </td>
      <td style={{ padding: "10px 8px" }}>
        {editing ? (
          <input
            type="number"
            step="0.01"
            value={editQty}
            onChange={(e) => setEditQty(e.target.value)}
            style={{
              width: "80px",
              padding: "6px 8px",
              border: "1px solid var(--p-color-border)",
              borderRadius: "4px",
              fontSize: "14px",
            }}
          />
        ) : (
          <s-text>{supplierSkuItem.supplierSkuQty}</s-text>
        )}
      </td>
      <td style={{ padding: "10px 8px", textAlign: "right" }}>
        <s-stack direction="inline" gap="small">
          {editing ? (
            <>
              <s-button variant="tertiary" onClick={handleSave}>
                Save
              </s-button>
              <s-button variant="tertiary" onClick={() => setEditing(false)}>
                Cancel
              </s-button>
            </>
          ) : (
            <>
              <s-button variant="tertiary" onClick={() => setEditing(true)}>
                Edit
              </s-button>
              <s-button
                variant="tertiary"
                tone="critical"
                onClick={() =>
                  onDelete(supplierSkuItem.id, supplierSkuItem.supplierSku)
                }
              >
                Delete
              </s-button>
            </>
          )}
        </s-stack>
      </td>
    </tr>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
