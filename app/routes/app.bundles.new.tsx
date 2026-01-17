import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useFetcher } from "react-router";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const name = formData.get("name") as string;
  const parentGid = formData.get("parentGid") as string;
  const expandOnPick = formData.get("expandOnPick") === "true";
  const childrenJson = formData.get("children") as string;

  if (!name || !parentGid || !childrenJson) {
    return { error: "Missing required fields" };
  }

  const children = JSON.parse(childrenJson) as ChildVariant[];

  if (children.length === 0) {
    return { error: "At least one child variant is required" };
  }

  // Ensure shop exists
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  // Check if bundle already exists for this parent
  const existing = await db.bundle.findUnique({
    where: {
      shopId_parentGid: {
        shopId: shop,
        parentGid,
      },
    },
  });

  if (existing) {
    return { error: "A bundle already exists for this variant" };
  }

  // Create bundle with children
  await db.bundle.create({
    data: {
      shopId: shop,
      name,
      parentGid,
      expandOnPick,
      children: {
        create: children.map((child) => ({
          childGid: child.gid,
          quantity: child.quantity,
        })),
      },
    },
  });

  return redirect("/app/bundles");
};

export default function NewBundle() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [name, setName] = useState("");
  const [parentVariant, setParentVariant] = useState<SelectedVariant | null>(
    null,
  );
  const [children, setChildren] = useState<ChildVariant[]>([]);
  const [expandOnPick, setExpandOnPick] = useState(false);

  const isSubmitting = fetcher.state === "submitting";

  const openParentPicker = async () => {
    const selection = await shopify.resourcePicker({
      type: "variant",
      multiple: false,
      action: "select",
    });

    if (selection && selection.length > 0) {
      const variant = selection[0] as SelectedVariant;
      setParentVariant(variant);
      if (!name) {
        const productTitle = variant.product?.title ?? "Unknown Product";
        setName(`${productTitle} - ${variant.title}`);
      }
    }
  };

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
    if (!parentVariant) {
      void shopify.toast.show("Please select a parent variant", {
        isError: true,
      });
      return;
    }

    if (children.length === 0) {
      void shopify.toast.show("Please add at least one child variant", {
        isError: true,
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      {
        name,
        parentGid: parentVariant.id,
        expandOnPick: String(expandOnPick),
        children: JSON.stringify(children),
      },
      { method: "POST" },
    );
  };

  return (
    <s-page
      heading="Create Bundle"
      back-action={JSON.stringify({ url: "/app/bundles" })}
    >
      <s-button
        slot="primary-action"
        onClick={handleSubmit}
        {...(isSubmitting ? { loading: true } : {})}
      >
        Create Bundle
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
            placeholder="e.g., Lager 24-Pack Bundle"
            onInput={(e: Event) => {
              const target = e.target as HTMLInputElement;
              setName(target.value);
            }}
            required
          />

          <s-stack direction="block" gap="small">
            <s-heading>Parent Variant</s-heading>
            <s-paragraph>
              The product variant that represents this bundle (e.g., the 24-Pack
              SKU)
            </s-paragraph>
            {parentVariant ? (
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack
                  direction="inline"
                  gap="base"
                  justifyContent="space-between"
                >
                  <s-stack direction="block" gap="small">
                    <s-text type="strong">
                      {parentVariant.product?.title} - {parentVariant.title}
                    </s-text>
                    <s-text tone="neutral">{parentVariant.id}</s-text>
                  </s-stack>
                  <s-button variant="secondary" onClick={openParentPicker}>
                    Change
                  </s-button>
                </s-stack>
              </s-box>
            ) : (
              <s-button onClick={openParentPicker}>
                Select Parent Variant
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Child Variants">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Add the component variants that make up this bundle, along with
            their quantities. For a 24-pack of singles, add the Single variant
            with quantity 24.
          </s-paragraph>

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
            components in the pick list instead of the bundle SKU. Useful for
            bundles that are assembled during fulfillment.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-ordered-list>
          <s-list-item>Select the parent variant (the bundle SKU)</s-list-item>
          <s-list-item>Add child variants with their quantities</s-list-item>
          <s-list-item>
            When inventory changes, all linked variants update automatically
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="Example">
        <s-paragraph>
          <s-text type="strong">24-Pack Bundle:</s-text>
        </s-paragraph>
        <s-paragraph>Parent: &ldquo;Lager - 24 Pack&rdquo; variant</s-paragraph>
        <s-paragraph>
          Child: &ldquo;Lager - Single&rdquo; with quantity 24
        </s-paragraph>
        <s-paragraph>48 singles in stock → 2 × 24-packs available</s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
