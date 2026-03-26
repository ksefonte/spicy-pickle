/**
 * Metaobject Setup Service
 *
 * Ensures the `product_relationship` metaobject definition and the
 * `$app:spicy_pickle.bundle_children` metafield definition exist in the store.
 *
 * Runs on app authenticate (idempotent — safe to call on every page load).
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const METAOBJECT_TYPE = "product_relationship";

const METAFIELD_NAMESPACE = "$app:spicy_pickle";
const METAFIELD_KEY = "bundle_children";
const METAFIELD_OWNER_TYPE = "PRODUCTVARIANT";

// ============================================================================
// Public API
// ============================================================================

/**
 * Ensures both the metaobject definition and metafield definition exist.
 * Safe to call repeatedly — checks for existence before creating.
 */
export async function ensureMetaobjectSetup(
  admin: AdminApiContext,
): Promise<void> {
  await ensureMetaobjectDefinition(admin);
  await ensureMetafieldDefinition(admin);
}

// ============================================================================
// Metaobject Definition
// ============================================================================

async function ensureMetaobjectDefinition(
  admin: AdminApiContext,
): Promise<void> {
  const existing = await getMetaobjectDefinition(admin);
  if (existing) {
    return;
  }

  console.log(`[Setup] Creating "${METAOBJECT_TYPE}" metaobject definition...`);

  const response = await admin.graphql(
    `#graphql
      mutation CreateProductRelationshipDefinition {
        metaobjectDefinitionCreate(definition: {
          type: "${METAOBJECT_TYPE}"
          name: "Product Relationship"
          description: "Links a child product variant with a quantity for bundle composition"
          access: {
            storefront: PUBLIC_READ
          }
          fieldDefinitions: [
            {
              key: "child"
              name: "Child"
              type: "variant_reference"
              required: true
            }
            {
              key: "quantity"
              name: "Quantity"
              type: "number_integer"
              required: true
            }
          ]
        }) {
          metaobjectDefinition {
            id
            type
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
  );

  const data: {
    data?: {
      metaobjectDefinitionCreate?: {
        metaobjectDefinition?: { id: string; type: string };
        userErrors?: Array<{ field: string; message: string }>;
      };
    };
  } = await response.json();

  const errors = data.data?.metaobjectDefinitionCreate?.userErrors;
  if (errors && errors.length > 0) {
    const isTaken = errors.some((e) =>
      e.message.toLowerCase().includes("taken"),
    );
    if (isTaken) {
      console.log(
        `[Setup] "${METAOBJECT_TYPE}" definition already exists (race condition), skipping.`,
      );
      return;
    }
    throw new Error(
      `Failed to create metaobject definition: ${JSON.stringify(errors)}`,
    );
  }

  console.log(
    `[Setup] Created "${METAOBJECT_TYPE}" metaobject definition: ${data.data?.metaobjectDefinitionCreate?.metaobjectDefinition?.id}`,
  );
}

async function getMetaobjectDefinition(
  admin: AdminApiContext,
): Promise<string | null> {
  const response = await admin.graphql(
    `#graphql
      query GetProductRelationshipDefinition($type: String!) {
        metaobjectDefinitionByType(type: $type) {
          id
          type
          fieldDefinitions {
            key
            type {
              name
            }
          }
        }
      }
    `,
    { variables: { type: METAOBJECT_TYPE } },
  );

  const data: {
    data?: {
      metaobjectDefinitionByType?: {
        id: string;
        type: string;
        fieldDefinitions: Array<{ key: string; type: { name: string } }>;
      };
    };
  } = await response.json();

  return data.data?.metaobjectDefinitionByType?.id ?? null;
}

// ============================================================================
// Metafield Definition
// ============================================================================

async function ensureMetafieldDefinition(
  admin: AdminApiContext,
): Promise<void> {
  const existing = await getMetafieldDefinition(admin);
  if (existing) {
    return;
  }

  console.log(
    `[Setup] Creating "${METAFIELD_NAMESPACE}.${METAFIELD_KEY}" metafield definition...`,
  );

  const response = await admin.graphql(
    `#graphql
      mutation CreateBundleChildrenMetafieldDefinition {
        metafieldDefinitionCreate(definition: {
          namespace: "${METAFIELD_NAMESPACE}"
          key: "${METAFIELD_KEY}"
          name: "Bundle Children"
          description: "Product relationships defining this variant's bundle composition"
          type: "list.metaobject_reference"
          ownerType: ${METAFIELD_OWNER_TYPE}
          validations: [
            {
              name: "metaobject_definition_id"
              value: "${METAOBJECT_TYPE}"
            }
          ]
        }) {
          createdDefinition {
            id
            namespace
            key
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
  );

  const data: {
    data?: {
      metafieldDefinitionCreate?: {
        createdDefinition?: { id: string; namespace: string; key: string };
        userErrors?: Array<{ field: string; message: string }>;
      };
    };
  } = await response.json();

  const errors = data.data?.metafieldDefinitionCreate?.userErrors;
  if (errors && errors.length > 0) {
    const alreadyExists = errors.some(
      (e) =>
        e.message.toLowerCase().includes("already exists") ||
        e.message.toLowerCase().includes("taken"),
    );
    if (alreadyExists) {
      console.log(
        `[Setup] Metafield definition already exists (race condition), skipping.`,
      );
      return;
    }
    throw new Error(
      `Failed to create metafield definition: ${JSON.stringify(errors)}`,
    );
  }

  console.log(
    `[Setup] Created metafield definition: ${data.data?.metafieldDefinitionCreate?.createdDefinition?.id}`,
  );
}

async function getMetafieldDefinition(
  admin: AdminApiContext,
): Promise<string | null> {
  const response = await admin.graphql(
    `#graphql
      query GetBundleChildrenMetafieldDefinition(
        $ownerType: MetafieldOwnerType!
        $namespace: String!
        $key: String!
      ) {
        metafieldDefinitions(
          first: 1
          ownerType: $ownerType
          namespace: $namespace
          key: $key
        ) {
          nodes {
            id
            namespace
            key
          }
        }
      }
    `,
    {
      variables: {
        ownerType: METAFIELD_OWNER_TYPE,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
      },
    },
  );

  const data: {
    data?: {
      metafieldDefinitions?: {
        nodes?: Array<{ id: string; namespace: string; key: string }>;
      };
    };
  } = await response.json();

  const nodes = data.data?.metafieldDefinitions?.nodes;
  return nodes && nodes.length > 0 ? (nodes[0]?.id ?? null) : null;
}
