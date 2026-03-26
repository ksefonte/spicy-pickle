/**
 * Metafields Service
 *
 * Syncs bin locations to Shopify product metafields.
 * Bundle configuration is now managed via metaobjects
 * (see metaobject-writes.server.ts).
 *
 * Metafield namespace: `spicy_pickle`
 * Keys:
 * - `bin_location`: String with warehouse bin location
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// ============================================================================
// Constants
// ============================================================================

const NAMESPACE = "spicy_pickle";
const BIN_LOCATION_KEY = "bin_location";

// ============================================================================
// Bin Location Metafield Functions
// ============================================================================

/**
 * Syncs bin location to a variant's metafield.
 */
export async function syncBinLocationMetafield(
  admin: AdminApiContext,
  variantGid: string,
  location: string,
): Promise<void> {
  await setVariantMetafield(admin, variantGid, BIN_LOCATION_KEY, {
    type: "single_line_text_field",
    value: location,
  });
}

/**
 * Removes bin location metafield from a variant.
 */
export async function deleteBinLocationMetafield(
  admin: AdminApiContext,
  variantGid: string,
): Promise<void> {
  await deleteVariantMetafield(admin, variantGid, BIN_LOCATION_KEY);
}

// ============================================================================
// Batch Sync Functions
// ============================================================================

/**
 * Syncs all bin location metafields for a shop.
 */
export async function syncAllBinLocationMetafields(
  admin: AdminApiContext,
  locations: Array<{ variantGid: string; location: string }>,
): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;

  for (const loc of locations) {
    try {
      await syncBinLocationMetafield(admin, loc.variantGid, loc.location);
      synced++;
    } catch (error) {
      console.error(
        `Failed to sync bin location for ${loc.variantGid}:`,
        error,
      );
      failed++;
    }
  }

  return { synced, failed };
}

// ============================================================================
// GraphQL Helpers
// ============================================================================

interface MetafieldValue {
  type: string;
  value: string;
}

/**
 * Sets a metafield on a product variant.
 */
async function setVariantMetafield(
  admin: AdminApiContext,
  variantGid: string,
  key: string,
  metafield: MetafieldValue,
): Promise<void> {
  const response: Response = await admin.graphql(
    `#graphql
      mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            namespace: NAMESPACE,
            key,
            ownerId: variantGid,
            type: metafield.type,
            value: metafield.value,
          },
        ],
      },
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: {
    data?: {
      metafieldsSet?: {
        userErrors?: Array<{ field: string; message: string }>;
      };
    };
  } = await response.json();

  const errors = data.data?.metafieldsSet?.userErrors;
  if (errors && errors.length > 0) {
    throw new Error(`Metafield error: ${errors[0]?.message}`);
  }
}

/**
 * Deletes a metafield from a product variant.
 */
async function deleteVariantMetafield(
  admin: AdminApiContext,
  variantGid: string,
  key: string,
): Promise<void> {
  // First, find the metafield ID
  const findResponse: Response = await admin.graphql(
    `#graphql
      query getMetafield($ownerId: ID!, $namespace: String!, $key: String!) {
        productVariant(id: $ownerId) {
          metafield(namespace: $namespace, key: $key) {
            id
          }
        }
      }
    `,
    {
      variables: {
        ownerId: variantGid,
        namespace: NAMESPACE,
        key,
      },
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const findData: {
    data?: {
      productVariant?: {
        metafield?: { id: string };
      };
    };
  } = await findResponse.json();

  const metafieldId = findData.data?.productVariant?.metafield?.id;

  if (!metafieldId) {
    // Metafield doesn't exist, nothing to delete
    return;
  }

  // Delete the metafield
  const deleteResponse: Response = await admin.graphql(
    `#graphql
      mutation deleteMetafield($input: MetafieldDeleteInput!) {
        metafieldDelete(input: $input) {
          deletedId
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: {
          id: metafieldId,
        },
      },
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const deleteData: {
    data?: {
      metafieldDelete?: {
        userErrors?: Array<{ field: string; message: string }>;
      };
    };
  } = await deleteResponse.json();

  const errors = deleteData.data?.metafieldDelete?.userErrors;
  if (errors && errors.length > 0) {
    throw new Error(`Metafield delete error: ${errors[0]?.message}`);
  }
}
