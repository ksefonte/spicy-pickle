/**
 * Metaobject Setup Service
 *
 * Ensures the `product_relationship` metaobject definition and the
 * `custom.product_relationships` metafield definition exist in the store.
 *
 * Runs on app authenticate (idempotent — safe to call on every page load).
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const METAOBJECT_TYPE = "product_relationship";

const METAFIELD_NAMESPACE = "custom";
const METAFIELD_KEY = "product_relationships";
const METAFIELD_OWNER_TYPE = "PRODUCTVARIANT";

export interface MetaobjectFieldMap {
  childKey: string;
  quantityKey: string;
}

let cachedFieldMap: MetaobjectFieldMap | null = null;

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
  const definitionGid = await ensureMetaobjectDefinition(admin);
  if (definitionGid) {
    await ensureMetafieldDefinition(admin, definitionGid);
    await getMetaobjectFieldMap(admin);
  }
}

// ============================================================================
// Metaobject Definition
// ============================================================================

async function ensureMetaobjectDefinition(
  admin: AdminApiContext,
): Promise<string | null> {
  const existingGid = await getMetaobjectDefinition(admin);
  if (existingGid) {
    return existingGid;
  }

  console.log(`[Setup] Creating "${METAOBJECT_TYPE}" metaobject definition...`);

  const response = await admin.graphql(
    `#graphql
      mutation CreateProductRelationshipDefinition {
        metaobjectDefinitionCreate(definition: {
          type: "product_relationship"
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
      return getMetaobjectDefinition(admin);
    }
    throw new Error(
      `Failed to create metaobject definition: ${JSON.stringify(errors)}`,
    );
  }

  const gid =
    data.data?.metaobjectDefinitionCreate?.metaobjectDefinition?.id ?? null;
  console.log(
    `[Setup] Created "${METAOBJECT_TYPE}" metaobject definition: ${gid}`,
  );
  return gid;
}

async function getMetaobjectDefinition(
  admin: AdminApiContext,
): Promise<string | null> {
  const response = await admin.graphql(
    `#graphql
      query GetProductRelationshipDefinition($type: String!) {
        metaobjectDefinitionByType(type: $type) {
          id
        }
      }
    `,
    { variables: { type: METAOBJECT_TYPE } },
  );

  const data: {
    data?: {
      metaobjectDefinitionByType?: { id: string };
    };
  } = await response.json();

  return data.data?.metaobjectDefinitionByType?.id ?? null;
}

// ============================================================================
// Field Map Discovery
// ============================================================================

/**
 * Queries the live metaobject definition and returns the actual field keys
 * for the variant reference and integer quantity fields. This handles cases
 * where the definition was created manually with different key names.
 */
export async function getMetaobjectFieldMap(
  admin: AdminApiContext,
): Promise<MetaobjectFieldMap> {
  if (cachedFieldMap) return cachedFieldMap;

  const response = await admin.graphql(
    `#graphql
      query GetProductRelationshipFields($type: String!) {
        metaobjectDefinitionByType(type: $type) {
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

  const data = (await response.json()) as {
    data?: {
      metaobjectDefinitionByType?: {
        fieldDefinitions: Array<{
          key: string;
          type: { name: string };
        }>;
      };
    };
  };

  const fields = data.data?.metaobjectDefinitionByType?.fieldDefinitions ?? [];

  const variantRefField = fields.find(
    (f) => f.type.name === "variant_reference",
  );
  const integerField = fields.find((f) => f.type.name === "number_integer");

  if (!variantRefField || !integerField) {
    console.error(
      "[Setup] Metaobject field definitions:",
      JSON.stringify(fields),
    );
    throw new Error(
      `product_relationship metaobject is missing expected fields. ` +
        `Found: ${fields.map((f) => `${f.key} (${f.type.name})`).join(", ")}. ` +
        `Need one variant_reference and one number_integer field.`,
    );
  }

  cachedFieldMap = {
    childKey: variantRefField.key,
    quantityKey: integerField.key,
  };

  console.log(
    `[Setup] Metaobject field map: child="${cachedFieldMap.childKey}", quantity="${cachedFieldMap.quantityKey}"`,
  );

  return cachedFieldMap;
}

// ============================================================================
// Metafield Definition
// ============================================================================

async function ensureMetafieldDefinition(
  admin: AdminApiContext,
  metaobjectDefinitionGid: string,
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
      mutation CreateBundleChildrenMetafieldDefinition(
        $definition: MetafieldDefinitionInput!
      ) {
        metafieldDefinitionCreate(definition: $definition) {
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
    {
      variables: {
        definition: {
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          name: "Product Relationships",
          description:
            "Product relationships defining this variant's bundle composition",
          type: "list.metaobject_reference",
          ownerType: METAFIELD_OWNER_TYPE,
          validations: [
            {
              name: "metaobject_definition_id",
              value: metaobjectDefinitionGid,
            },
          ],
        },
      },
    },
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
        nodes?: Array<{ id: string }>;
      };
    };
  } = await response.json();

  const nodes = data.data?.metafieldDefinitions?.nodes;
  return nodes && nodes.length > 0 ? (nodes[0]?.id ?? null) : null;
}
