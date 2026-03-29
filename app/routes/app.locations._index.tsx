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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

  return { bins, shop };
};

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

function shortenGid(gid: string): string {
  const match = gid.match(/\/(\d+)$/);
  return match ? `…${match[1]}` : gid;
}

export default function LocationsIndex() {
  const { bins } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [newBinOpen, setNewBinOpen] = useState(false);
  const [newBinName, setNewBinName] = useState("");
  const [newBinDescription, setNewBinDescription] = useState("");

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
                        {bin.variants.length} SKU
                        {bin.variants.length !== 1 ? "s" : ""}
                      </s-text>
                    </s-stack>

                    {/* Variant list */}
                    {bin.variants.length > 0 && (
                      <div style={{ paddingLeft: "32px" }}>
                        {bin.variants.map((v, vi) => (
                          <div
                            key={v.id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "4px 0",
                              borderBottom:
                                vi < bin.variants.length - 1
                                  ? "1px solid var(--p-color-border-subdued)"
                                  : "none",
                            }}
                          >
                            <s-text tone="neutral">
                              {vi < bin.variants.length - 1 ? "├" : "└"}{" "}
                              {shortenGid(v.variantGid)}
                            </s-text>
                            <button
                              onClick={() =>
                                handleRemoveVariant(bin.id, v.variantGid)
                              }
                              title="Remove variant"
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                color: "var(--p-color-text-critical)",
                                fontSize: "14px",
                                padding: "2px 6px",
                              }}
                            >
                              ✕
                            </button>
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
                        + Add Variants
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
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Reordering">
        <s-paragraph>
          Use the ▲▼ arrows to reorder bins. The pick list will follow this
          order so you can match your warehouse walk path.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
