import { useState, useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface ChildVariant {
  gid: string;
  title: string;
  quantity: number;
}

interface SelectedVariant {
  id: string;
  title: string;
  product?: {
    title: string;
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const bundleId = params.id;

  if (!bundleId) {
    throw new Response("Bundle ID required", { status: 400 });
  }

  const bundle = await db.bundle.findUnique({
    where: {
      id: bundleId,
      shopId: shop,
    },
    include: {
      children: true,
    },
  });

  if (!bundle) {
    throw new Response("Bundle not found", { status: 404 });
  }

  // Fetch variant titles from Shopify for better display
  const variantGids = [
    bundle.parentGid,
    ...bundle.children.map((c) => c.childGid),
  ];

  const variantTitles: Record<string, string> = {};

  try {
    const response = await admin.graphql(
      `#graphql
        query getVariants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              title
              product {
                title
              }
            }
          }
        }
      `,
      { variables: { ids: variantGids } },
    );

    const data = await response.json();

    for (const node of data.data?.nodes ?? []) {
      if (node?.id) {
        variantTitles[node.id] =
          `${node.product?.title ?? "Unknown"} - ${node.title}`;
      }
    }
  } catch {
    console.error("Failed to fetch variant titles");
  }

  return { bundle, variantTitles };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const bundleId = params.id;

  if (!bundleId) {
    return { error: "Bundle ID required" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    await db.bundle.delete({
      where: {
        id: bundleId,
        shopId: shop,
      },
    });
    return redirect("/app/bundles");
  }

  if (intent === "update") {
    const name = formData.get("name") as string;
    const expandOnPick = formData.get("expandOnPick") === "true";
    const childrenJson = formData.get("children") as string;

    if (!name || !childrenJson) {
      return { error: "Missing required fields" };
    }

    const children = JSON.parse(childrenJson) as ChildVariant[];

    if (children.length === 0) {
      return { error: "At least one child variant is required" };
    }

    await db.bundle.update({
      where: {
        id: bundleId,
        shopId: shop,
      },
      data: {
        name,
        expandOnPick,
        children: {
          deleteMany: {},
          create: children.map((child) => ({
            childGid: child.gid,
            quantity: child.quantity,
          })),
        },
      },
    });

    return { success: true };
  }

  return { error: "Unknown action" };
};

export default function EditBundle() {
  const { bundle, variantTitles } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [name, setName] = useState(bundle.name);
  const [children, setChildren] = useState<ChildVariant[]>(
    bundle.children.map((c) => ({
      gid: c.childGid,
      title: variantTitles[c.childGid] ?? c.childGid,
      quantity: c.quantity,
    })),
  );
  const [expandOnPick, setExpandOnPick] = useState(bundle.expandOnPick);

  const isSubmitting = fetcher.state === "submitting";
  const parentTitle = variantTitles[bundle.parentGid] ?? bundle.parentGid;

  useEffect(() => {
    if (fetcher.data?.success) {
      void shopify.toast.show("Bundle updated successfully");
    }
  }, [fetcher.data, shopify]);

  const openChildPicker = async () => {
    const selection = await shopify.resourcePicker({
      type: "variant",
      multiple: true,
      action: "select",
    });

    if (selection && selection.length > 0) {
      const newChildren = (selection as SelectedVariant[]).map((variant) => ({
        gid: variant.id,
        title: `${variant.product?.title ?? "Unknown"} - ${variant.title}`,
        quantity: 1,
      }));

      const existingGids = new Set(children.map((c) => c.gid));
      const toAdd = newChildren.filter((c) => !existingGids.has(c.gid));
      setChildren([...children, ...toAdd]);
    }
  };

  const updateChildQuantity = (gid: string, quantity: number) => {
    setChildren(
      children.map((child) =>
        child.gid === gid
          ? { ...child, quantity: Math.max(1, quantity) }
          : child,
      ),
    );
  };

  const removeChild = (gid: string) => {
    setChildren(children.filter((child) => child.gid !== gid));
  };

  const handleSubmit = () => {
    if (children.length === 0) {
      void shopify.toast.show("Please add at least one child variant", {
        isError: true,
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        intent: "update",
        name,
        expandOnPick: String(expandOnPick),
        children: JSON.stringify(children),
      },
      { method: "POST" },
    );
  };

  const handleDelete = () => {
    if (confirm(`Are you sure you want to delete "${bundle.name}"?`)) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit({ intent: "delete" }, { method: "POST" });
    }
  };

  return (
    <s-page
      heading={`Edit: ${bundle.name}`}
      back-action={JSON.stringify({ url: "/app/bundles" })}
    >
      <s-button
        slot="primary-action"
        onClick={handleSubmit}
        {...(isSubmitting ? { loading: true } : {})}
      >
        Save Changes
      </s-button>
      <s-button slot="secondary-action" tone="critical" onClick={handleDelete}>
        Delete Bundle
      </s-button>

      {fetcher.data?.error && (
        <s-banner tone="critical" dismissible>
          {fetcher.data.error}
        </s-banner>
      )}

      <s-section heading="Bundle Details">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Bundle Name"
            value={name}
            onInput={(e: Event) => {
              const target = e.target as HTMLInputElement;
              setName(target.value);
            }}
            required
          />

          <s-stack direction="block" gap="small">
            <s-heading>Parent Variant</s-heading>
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small">
                <s-text>{parentTitle}</s-text>
                <s-text tone="neutral">{bundle.parentGid}</s-text>
              </s-stack>
            </s-box>
            <s-paragraph>
              Parent variant cannot be changed. Delete and recreate the bundle
              to change it.
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Child Variants">
        <s-stack direction="block" gap="base">
          {children.length > 0 && (
            <s-stack direction="block" gap="small">
              {children.map((child) => (
                <s-box
                  key={child.gid}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack
                    direction="inline"
                    gap="base"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-stack direction="block" gap="small">
                      <s-text>{child.title}</s-text>
                      <s-text tone="neutral">{child.gid}</s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-number-field
                        label="Qty"
                        value={String(child.quantity)}
                        min={1}
                        onInput={(e: Event) => {
                          const target = e.target as HTMLInputElement;
                          updateChildQuantity(
                            child.gid,
                            parseInt(target.value, 10) || 1,
                          );
                        }}
                      />
                      <s-button
                        variant="secondary"
                        tone="critical"
                        onClick={() => removeChild(child.gid)}
                      >
                        Remove
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}

          <s-button variant="secondary" onClick={openChildPicker}>
            {children.length > 0 ? "Add More Components" : "Add Child Variants"}
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Pick List Options">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Expand to components in pick list"
            checked={expandOnPick}
            onChange={(e: Event) => {
              const target = e.target as HTMLInputElement;
              setExpandOnPick(target.checked);
            }}
          />
          <s-paragraph>
            When enabled, orders for this bundle will show the individual
            components in the pick list instead of the bundle SKU.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Bundle Info">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            <s-text type="strong">Created:</s-text>{" "}
            {new Date(bundle.createdAt).toLocaleDateString()}
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Updated:</s-text>{" "}
            {new Date(bundle.updatedAt).toLocaleDateString()}
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Components:</s-text> {children.length}
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
