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
import {
  syncBinLocationMetafield,
  deleteBinLocationMetafield,
} from "../services/metafields.server";

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

  // Fetch bin locations
  const locations = await db.binLocation.findMany({
    where: {
      shopId: shop,
      ...(search
        ? {
            OR: [
              { location: { contains: search } },
              { variantGid: { contains: search } },
            ],
          }
        : {}),
    },
    orderBy: { location: "asc" },
  });

  return { locations, shop, search };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const locationId = formData.get("locationId") as string;

    // Get the bin location first to get the variantGid
    const binLocation = await db.binLocation.findUnique({
      where: { id: locationId, shopId: shop },
    });

    if (binLocation) {
      // Delete metafield
      try {
        await deleteBinLocationMetafield(admin, binLocation.variantGid);
      } catch (error) {
        console.error("Failed to delete bin location metafield:", error);
      }
    }

    await db.binLocation.delete({
      where: {
        id: locationId,
        shopId: shop,
      },
    });

    return { deleted: true };
  }

  if (intent === "update") {
    const locationId = formData.get("locationId") as string;
    const newLocation = formData.get("location") as string;

    const binLocation = await db.binLocation.update({
      where: {
        id: locationId,
        shopId: shop,
      },
      data: {
        location: newLocation,
      },
    });

    // Sync to metafield
    try {
      await syncBinLocationMetafield(
        admin,
        binLocation.variantGid,
        newLocation,
      );
    } catch (error) {
      console.error("Failed to sync bin location metafield:", error);
    }

    return { updated: true };
  }

  if (intent === "create") {
    const variantGid = formData.get("variantGid") as string;
    const location = formData.get("location") as string;

    // Ensure shop exists
    await db.shop.upsert({
      where: { id: shop },
      create: { id: shop },
      update: {},
    });

    await db.binLocation.upsert({
      where: {
        shopId_variantGid: {
          shopId: shop,
          variantGid,
        },
      },
      create: {
        shopId: shop,
        variantGid,
        location,
      },
      update: {
        location,
      },
    });

    // Sync to metafield
    try {
      await syncBinLocationMetafield(admin, variantGid, location);
    } catch (error) {
      console.error("Failed to sync bin location metafield:", error);
    }

    return { created: true };
  }

  return { error: "Unknown action" };
};

export default function LocationsIndex() {
  const { locations, search } = useLoaderData<typeof loader>();
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

  const handleDelete = (locationId: string, variantGid: string) => {
    if (confirm(`Delete bin location for ${variantGid}?`)) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetcher.submit({ intent: "delete", locationId }, { method: "POST" });
    }
  };

  const handleUpdate = (locationId: string, newLocation: string) => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetcher.submit(
      { intent: "update", locationId, location: newLocation },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Bin Locations">
      <s-button
        slot="primary-action"
        onClick={() => navigate("/app/locations/import")}
      >
        Import CSV
      </s-button>

      <s-section heading="Warehouse Bin Locations">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Search locations"
            value={search}
            placeholder="Search by location or variant GID..."
            onInput={(e: Event) => {
              const target = e.target as HTMLInputElement;
              handleSearch(target.value);
            }}
          />

          {locations.length === 0 ? (
            <s-box padding="large" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>No bin locations configured</s-heading>
                <s-paragraph>
                  Import bin locations via CSV to enable warehouse picking with
                  location information.
                </s-paragraph>
                <s-button onClick={() => navigate("/app/locations/import")}>
                  Import locations
                </s-button>
              </s-stack>
            </s-box>
          ) : (
            <s-stack direction="block" gap="small">
              {locations.map((loc) => (
                <s-box
                  key={loc.id}
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
                      <s-heading>{loc.location}</s-heading>
                      <s-text tone="neutral">{loc.variantGid}</s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="small">
                      <s-button
                        variant="secondary"
                        onClick={() => {
                          const newLoc = prompt(
                            "New bin location:",
                            loc.location,
                          );
                          if (newLoc && newLoc !== loc.location) {
                            handleUpdate(loc.id, newLoc);
                          }
                        }}
                      >
                        Edit
                      </s-button>
                      <s-button
                        variant="secondary"
                        tone="critical"
                        onClick={() => handleDelete(loc.id, loc.variantGid)}
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}

          <s-paragraph tone="neutral">
            {locations.length} bin location{locations.length !== 1 ? "s" : ""}{" "}
            configured
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About Bin Locations">
        <s-paragraph>
          Bin locations help warehouse staff quickly find products when picking
          orders. Each product variant can have one bin location assigned.
        </s-paragraph>
        <s-paragraph>
          The pick list will be sorted by bin location for efficient warehouse
          navigation.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="CSV Format">
        <s-paragraph>
          Import bin locations using a CSV file with the following columns:
        </s-paragraph>
        <s-box padding="base" borderRadius="base" background="subdued">
          <code>variant_gid,variant_sku,bin_location</code>
        </s-box>
        <s-paragraph tone="neutral">
          The variant_sku column is optional and used for reference only.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
