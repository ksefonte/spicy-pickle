import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/* ─── types shared between loader & component ─── */

interface VariantInfo {
  gid: string;
  title: string;
  productGid: string;
  productTitle: string;
}

interface ProductGroup {
  productGid: string;
  productTitle: string;
  variants: VariantInfo[];
  allVariantsInBin: boolean;
}

interface BinWithGroups {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  variantCount: number;
  products: ProductGroup[];
}

/* ─── loader ─── */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  const bins = await db.bin.findMany({
    where: { shopId: shop },
    include: { variants: true },
    orderBy: { sortOrder: "asc" },
  });

  const allGids = new Set<string>();
  for (const bin of bins) {
    for (const v of bin.variants) {
      allGids.add(v.variantGid);
    }
  }

  interface VariantNode {
    id: string;
    title: string;
    product: { id: string; title: string; totalVariants: number };
  }
  interface NodesResponse {
    nodes: Array<VariantNode | null>;
  }

  const variantMap = new Map<
    string,
    {
      title: string;
      productGid: string;
      productTitle: string;
      totalVariants: number;
    }
  >();

  if (allGids.size > 0) {
    const gidsArray = Array.from(allGids);
    const BATCH_SIZE = 250;
    for (let i = 0; i < gidsArray.length; i += BATCH_SIZE) {
      const batch = gidsArray.slice(i, i + BATCH_SIZE);
      const response = await admin.graphql(
        `#graphql
        query GetVariantInfo($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              title
              product {
                id
                title
                totalVariants: variantsCount { count }
              }
            }
          }
        }`,
        { variables: { ids: batch } },
      );
      const data: NodesResponse = (await response.json()).data;
      for (const node of data.nodes) {
        if (!node) continue;
        const totalVariants =
          typeof node.product.totalVariants === "number"
            ? node.product.totalVariants
            : ((node.product.totalVariants as unknown as { count: number })
                ?.count ?? 0);
        variantMap.set(node.id, {
          title: node.title,
          productGid: node.product.id,
          productTitle: node.product.title,
          totalVariants,
        });
      }
    }
  }

  const binsWithGroups: BinWithGroups[] = bins.map((bin) => {
    const variantInfos: VariantInfo[] = bin.variants.map((v) => {
      const info = variantMap.get(v.variantGid);
      return {
        gid: v.variantGid,
        title: info?.title ?? v.variantGid,
        productGid: info?.productGid ?? "unknown",
        productTitle: info?.productTitle ?? "Unknown Product",
      };
    });

    const byProduct = new Map<string, VariantInfo[]>();
    for (const vi of variantInfos) {
      const arr = byProduct.get(vi.productGid) ?? [];
      arr.push(vi);
      byProduct.set(vi.productGid, arr);
    }

    const products: ProductGroup[] = [];
    for (const [productGid, variants] of byProduct) {
      const info = variantMap.get(variants[0]?.gid ?? "");
      const totalVariants = info?.totalVariants ?? 0;
      products.push({
        productGid,
        productTitle: variants[0]?.productTitle ?? "Unknown Product",
        variants: variants.sort((a, b) => a.title.localeCompare(b.title)),
        allVariantsInBin: totalVariants > 0 && variants.length >= totalVariants,
      });
    }
    products.sort((a, b) => a.productTitle.localeCompare(b.productTitle));

    return {
      id: bin.id,
      name: bin.name,
      description: bin.description,
      sortOrder: bin.sortOrder,
      variantCount: bin.variants.length,
      products,
    };
  });

  return { bins: binsWithGroups, shop };
};

/* ─── action ─── */

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create_bin") {
    const name = formData.get("name") as string;
    const description = (formData.get("description") as string) || null;

    const maxOrder = await db.bin.aggregate({
      where: { shopId: shop },
      _max: { sortOrder: true },
    });

    await db.bin.create({
      data: {
        shopId: shop,
        name,
        description,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      },
    });

    return { created: true };
  }

  if (intent === "update_bin") {
    const binId = formData.get("binId") as string;
    const name = formData.get("name") as string | null;
    const description = formData.get("description") as string | null;

    const data: Record<string, string> = {};
    if (name !== null) data.name = name;
    if (description !== null) data.description = description;

    await db.bin.update({
      where: { id: binId, shopId: shop },
      data,
    });

    return { updated: true };
  }

  if (intent === "delete_bin") {
    const binId = formData.get("binId") as string;

    await db.bin.delete({
      where: { id: binId, shopId: shop },
    });

    return { deleted: true };
  }

  if (intent === "add_variants") {
    const binId = formData.get("binId") as string;
    const variantGids: string[] = JSON.parse(
      formData.get("variantGids") as string,
    );

    for (const variantGid of variantGids) {
      await db.binVariant.deleteMany({
        where: { shopId: shop, variantGid },
      });
      await db.binVariant.create({
        data: { binId, shopId: shop, variantGid },
      });
    }

    return { added: true };
  }

  if (intent === "remove_variant") {
    const binId = formData.get("binId") as string;
    const variantGid = formData.get("variantGid") as string;

    await db.binVariant.delete({
      where: { binId_variantGid: { binId, variantGid } },
    });

    return { removed: true };
  }

  if (intent === "remove_product") {
    const binId = formData.get("binId") as string;
    const variantGids: string[] = JSON.parse(
      formData.get("variantGids") as string,
    );

    await db.binVariant.deleteMany({
      where: { binId, variantGid: { in: variantGids } },
    });

    return { removed: true };
  }

  if (intent === "move_variants") {
    const targetBinId = formData.get("targetBinId") as string;
    const variantGids: string[] = JSON.parse(
      formData.get("variantGids") as string,
    );

    for (const variantGid of variantGids) {
      await db.binVariant.deleteMany({
        where: { shopId: shop, variantGid },
      });
      await db.binVariant.create({
        data: { binId: targetBinId, shopId: shop, variantGid },
      });
    }

    return { moved: true };
  }

  if (intent === "reorder") {
    const order: Array<{ id: string; sortOrder: number }> = JSON.parse(
      formData.get("order") as string,
    );

    for (const item of order) {
      await db.bin.update({
        where: { id: item.id, shopId: shop },
        data: { sortOrder: item.sortOrder },
      });
    }

    return { reordered: true };
  }

  return { error: "Unknown action" };
};

/* ─── component ─── */

export default function LocationsIndex() {
  const { bins } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [newBinOpen, setNewBinOpen] = useState(false);
  const [newBinName, setNewBinName] = useState("");
  const [newBinDescription, setNewBinDescription] = useState("");
  const [movingItem, setMovingItem] = useState<{
    sourceBinId: string;
    variantGids: string[];
    label: string;
  } | null>(null);

  const handleCreateBin = () => {
    if (!newBinName.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "create_bin",
        name: newBinName.trim(),
        description: newBinDescription.trim(),
      },
      { method: "POST" },
    );
    setNewBinName("");
    setNewBinDescription("");
    setNewBinOpen(false);
  };

  const handleDeleteBin = (binId: string, binName: string) => {
    if (confirm(`Delete bin "${binName}" and all its variant assignments?`)) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit({ intent: "delete_bin", binId }, { method: "POST" });
    }
  };

  const handleEditBin = (
    binId: string,
    currentName: string,
    currentDescription: string,
  ) => {
    const name = prompt("Bin name:", currentName);
    if (name === null) return;
    const description = prompt("Description (optional):", currentDescription);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "update_bin", binId, name, description: description ?? "" },
      { method: "POST" },
    );
  };

  const handleAddVariants = async (binId: string) => {
    const selected = await window.shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: [],
      filter: { variants: true },
    });
    if (!selected || selected.length === 0) return;

    const variantGids: string[] = [];
    for (const product of selected) {
      for (const v of product.variants) {
        if (v.id) variantGids.push(v.id);
      }
    }
    if (variantGids.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "add_variants",
        binId,
        variantGids: JSON.stringify(variantGids),
      },
      { method: "POST" },
    );
  };

  const handleRemoveVariant = (binId: string, variantGid: string) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "remove_variant", binId, variantGid },
      { method: "POST" },
    );
  };

  const handleRemoveProduct = (binId: string, group: ProductGroup) => {
    if (
      !confirm(
        `Remove all ${group.variants.length} variant(s) of "${group.productTitle}" from this bin?`,
      )
    )
      return;
    const gids = group.variants.map((v) => v.gid);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "remove_product",
        binId,
        variantGids: JSON.stringify(gids),
      },
      { method: "POST" },
    );
  };

  const handleStartMove = (
    sourceBinId: string,
    variantGids: string[],
    label: string,
  ) => {
    setMovingItem({ sourceBinId, variantGids, label });
  };

  const handleConfirmMove = (targetBinId: string) => {
    if (!movingItem) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "move_variants",
        targetBinId,
        variantGids: JSON.stringify(movingItem.variantGids),
      },
      { method: "POST" },
    );
    setMovingItem(null);
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const order = bins.map((b) => ({ id: b.id, sortOrder: b.sortOrder }));
    const current = order[index];
    const prev = order[index - 1];
    if (!current || !prev) return;
    const temp = current.sortOrder;
    current.sortOrder = prev.sortOrder;
    prev.sortOrder = temp;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "reorder", order: JSON.stringify(order) },
      { method: "POST" },
    );
  };

  const handleMoveDown = (index: number) => {
    if (index >= bins.length - 1) return;
    const order = bins.map((b) => ({ id: b.id, sortOrder: b.sortOrder }));
    const current = order[index];
    const next = order[index + 1];
    if (!current || !next) return;
    const temp = current.sortOrder;
    current.sortOrder = next.sortOrder;
    next.sortOrder = temp;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "reorder", order: JSON.stringify(order) },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Bin Locations">
      <s-button slot="primary-action" onClick={() => setNewBinOpen(true)}>
        + New Bin
      </s-button>

      {/* Move-to-bin modal */}
      {movingItem && (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setMovingItem(null)}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            role="dialog"
            aria-label={`Move ${movingItem.label}`}
            style={{
              background: "var(--p-color-bg-surface, #fff)",
              borderRadius: "12px",
              padding: "20px",
              minWidth: "320px",
              maxWidth: "400px",
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setMovingItem(null);
            }}
          >
            <s-stack direction="block" gap="base">
              <s-heading>Move {movingItem.label}</s-heading>
              <s-text tone="neutral">Select destination bin:</s-text>
              <s-stack direction="block" gap="small">
                {bins
                  .filter((b) => b.id !== movingItem.sourceBinId)
                  .map((b) => (
                    <s-button
                      key={b.id}
                      variant="secondary"
                      onClick={() => handleConfirmMove(b.id)}
                    >
                      {b.name}
                    </s-button>
                  ))}
              </s-stack>
              <s-button variant="tertiary" onClick={() => setMovingItem(null)}>
                Cancel
              </s-button>
            </s-stack>
          </div>
        </div>
      )}

      <s-section heading="Warehouse Bins">
        <s-stack direction="block" gap="base">
          {newBinOpen && (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small">
                <s-heading>Create New Bin</s-heading>
                <s-text-field
                  label="Name"
                  value={newBinName}
                  placeholder='e.g. "A1-03", "Cold Room"'
                  onInput={(e: Event) =>
                    setNewBinName((e.target as HTMLInputElement).value)
                  }
                />
                <s-text-field
                  label="Description (optional)"
                  value={newBinDescription}
                  placeholder="Optional description"
                  onInput={(e: Event) =>
                    setNewBinDescription((e.target as HTMLInputElement).value)
                  }
                />
                <s-stack direction="inline" gap="small">
                  <s-button onClick={handleCreateBin}>Create</s-button>
                  <s-button
                    variant="secondary"
                    onClick={() => setNewBinOpen(false)}
                  >
                    Cancel
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          )}

          {bins.length === 0 && !newBinOpen ? (
            <s-box padding="large" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>No bins configured</s-heading>
                <s-paragraph>
                  Create bins to organize your warehouse. Each product variant
                  can be assigned to one bin for efficient picking.
                </s-paragraph>
                <s-button onClick={() => setNewBinOpen(true)}>
                  Create your first bin
                </s-button>
              </s-stack>
            </s-box>
          ) : (
            <s-stack direction="block" gap="small">
              {bins.map((bin, index) => (
                <s-box
                  key={bin.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="small">
                    {/* Header row */}
                    <s-stack
                      direction="inline"
                      gap="base"
                      justifyContent="space-between"
                      alignItems="center"
                    >
                      <s-stack
                        direction="inline"
                        gap="small"
                        alignItems="center"
                      >
                        <s-stack direction="block" gap="none">
                          <button
                            disabled={index === 0}
                            onClick={() => handleMoveUp(index)}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: index === 0 ? "default" : "pointer",
                              opacity: index === 0 ? 0.3 : 1,
                              padding: "0 4px",
                              fontSize: "12px",
                              lineHeight: 1,
                            }}
                            title="Move up"
                          >
                            ▲
                          </button>
                          <button
                            disabled={index >= bins.length - 1}
                            onClick={() => handleMoveDown(index)}
                            style={{
                              background: "none",
                              border: "none",
                              cursor:
                                index >= bins.length - 1
                                  ? "default"
                                  : "pointer",
                              opacity: index >= bins.length - 1 ? 0.3 : 1,
                              padding: "0 4px",
                              fontSize: "12px",
                              lineHeight: 1,
                            }}
                            title="Move down"
                          >
                            ▼
                          </button>
                        </s-stack>
                        <s-text type="strong">{bin.name}</s-text>
                        {bin.description && (
                          <s-text tone="neutral">— {bin.description}</s-text>
                        )}
                      </s-stack>
                      <s-text tone="neutral">
                        {bin.products.length} product
                        {bin.products.length !== 1 ? "s" : ""},{" "}
                        {bin.variantCount} SKU
                        {bin.variantCount !== 1 ? "s" : ""}
                      </s-text>
                    </s-stack>

                    {/* Product groups */}
                    {bin.products.length > 0 && (
                      <div style={{ paddingLeft: "32px" }}>
                        {bin.products.map((group, gi) => (
                          <div
                            key={group.productGid}
                            style={{
                              borderBottom:
                                gi < bin.products.length - 1
                                  ? "1px solid var(--p-color-border-subdued, #e1e3e5)"
                                  : "none",
                              padding: "6px 0",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                  flex: 1,
                                  minWidth: 0,
                                }}
                              >
                                <s-text type="strong">
                                  {group.productTitle}
                                </s-text>
                                {group.allVariantsInBin ? (
                                  <span
                                    style={{
                                      fontSize: "11px",
                                      color:
                                        "var(--p-color-text-success, #008060)",
                                      background:
                                        "var(--p-color-bg-success-subdued, #f1f8f5)",
                                      padding: "1px 6px",
                                      borderRadius: "4px",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    All variants
                                  </span>
                                ) : (
                                  <span
                                    style={{
                                      fontSize: "11px",
                                      color:
                                        "var(--p-color-text-subdued, #6d7175)",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {group.variants.length} variant
                                    {group.variants.length !== 1 ? "s" : ""}
                                  </span>
                                )}
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  gap: "4px",
                                  flexShrink: 0,
                                }}
                              >
                                <button
                                  onClick={() =>
                                    handleStartMove(
                                      bin.id,
                                      group.variants.map((v) => v.gid),
                                      group.productTitle,
                                    )
                                  }
                                  title={`Move ${group.productTitle} to another bin`}
                                  style={{
                                    background: "none",
                                    border: "none",
                                    cursor: "pointer",
                                    color:
                                      "var(--p-color-text-secondary, #6d7175)",
                                    fontSize: "12px",
                                    padding: "2px 6px",
                                  }}
                                >
                                  Move
                                </button>
                                <button
                                  onClick={() =>
                                    handleRemoveProduct(bin.id, group)
                                  }
                                  title={`Remove ${group.productTitle}`}
                                  style={{
                                    background: "none",
                                    border: "none",
                                    cursor: "pointer",
                                    color:
                                      "var(--p-color-text-critical, #d72c0d)",
                                    fontSize: "12px",
                                    padding: "2px 6px",
                                  }}
                                >
                                  Remove
                                </button>
                              </div>
                            </div>

                            {/* Only show individual variants when NOT all variants are in this bin */}
                            {!group.allVariantsInBin && (
                              <div
                                style={{
                                  paddingLeft: "16px",
                                  marginTop: "2px",
                                }}
                              >
                                {group.variants.map((v) => (
                                  <div
                                    key={v.gid}
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "center",
                                      padding: "2px 0",
                                    }}
                                  >
                                    <s-text tone="neutral">{v.title}</s-text>
                                    <div
                                      style={{ display: "flex", gap: "4px" }}
                                    >
                                      <button
                                        onClick={() =>
                                          handleStartMove(
                                            bin.id,
                                            [v.gid],
                                            `${group.productTitle} — ${v.title}`,
                                          )
                                        }
                                        title={`Move ${v.title} to another bin`}
                                        style={{
                                          background: "none",
                                          border: "none",
                                          cursor: "pointer",
                                          color:
                                            "var(--p-color-text-secondary, #6d7175)",
                                          fontSize: "11px",
                                          padding: "1px 4px",
                                        }}
                                      >
                                        Move
                                      </button>
                                      <button
                                        onClick={() =>
                                          handleRemoveVariant(bin.id, v.gid)
                                        }
                                        title={`Remove ${v.title}`}
                                        style={{
                                          background: "none",
                                          border: "none",
                                          cursor: "pointer",
                                          color:
                                            "var(--p-color-text-critical, #d72c0d)",
                                          fontSize: "11px",
                                          padding: "1px 4px",
                                        }}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Action buttons */}
                    <s-stack
                      direction="inline"
                      gap="small"
                      justifyContent="end"
                    >
                      <s-button
                        variant="tertiary"
                        onClick={() => {
                          // eslint-disable-next-line @typescript-eslint/no-floating-promises
                          handleAddVariants(bin.id);
                        }}
                      >
                        + Add Products
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          handleEditBin(bin.id, bin.name, bin.description ?? "")
                        }
                      >
                        Edit
                      </s-button>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => handleDeleteBin(bin.id, bin.name)}
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}

          <s-text tone="neutral">
            {bins.length} bin{bins.length !== 1 ? "s" : ""} configured
          </s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About Bins">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Bins represent physical locations in your warehouse (shelves, cold
            rooms, racks, etc.). Assign product variants to bins so pick lists
            are sorted by location for efficient warehouse navigation.
          </s-paragraph>
          <s-paragraph>
            Each variant can only belong to one bin at a time. Adding a variant
            to a new bin automatically removes it from its previous bin.
          </s-paragraph>
          <s-paragraph>
            Products where all variants are in the same bin are shown condensed.
            Products with variants spread across bins show each variant
            individually for clarity.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Reordering &amp; Moving">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Use the ▲▼ arrows to reorder bins. The pick list will follow this
            order so you can match your warehouse walk path.
          </s-paragraph>
          <s-paragraph>
            Use the Move button on any product or variant to transfer it to a
            different bin.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
