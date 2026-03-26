# Metaobject-Based Product Relationships Plan

## Summary

Migrate bundle composition data from app-only storage (Prisma DB + JSON metafield) to **Shopify metaobjects** as the source of truth, while retaining Prisma as a local cache for the performance-critical inventory sync path.

### Current System

```
Variant metafields (per variant):
  bundle_base: boolean       — is this the base unit? (e.g., single can)
  bundle_quant: integer      — how many base units this variant represents

Bundle (Prisma)         →  BundleChild[] (Prisma)
  parentGid                  childGid, quantity
        ↓ sync
  spicy_pickle.bundle_config (JSON metafield on parent variant)
```

### Proposed System

```
product_relationship (Shopify Metaobject — merchant-owned, global)
  child: variant_reference
  quantity: number_integer
        ↓ attached via
  $app:spicy_pickle.bundle_children (list.metaobject_reference on parent variant)
        ↓ cached to
  Bundle + BundleChild (Prisma) — used by inventory sync + pick list
```

### Key Design Decisions

- **Metaobject definition ownership**: Merchant-owned (global, no `$app:` prefix). Created via GraphQL at runtime with idempotent "ensure exists" logic. This keeps the metaobject visible and editable by all apps and in the Shopify admin. Can be switched to app-owned TOML (`$app:product_relationship`) later for public distribution.
- **Metafield attachment point**: ProductVariant (not Product). Each variant that acts as a bundle parent gets its own `list.metaobject_reference` metafield. This handles both same-product bundles (4-Pack variant → Single x4) and mixed packs (Mixed Pack variant → Beer A x1, Beer B x1, ...).
- **`expandOnPick` stays in Prisma**: This is app-specific behavior, not composition data. It doesn't belong in the metaobject.
- **Prisma remains the hot-path cache**: Inventory webhooks read from Prisma (indexed DB queries, ~1ms) instead of making 2-3 extra Shopify API calls per event. This avoids rate limit pressure during stock takes.

---

## Phase 1: Scopes & Metaobject Definition Setup

### 1a. Add Required Scopes

Update `shopify.app.toml`:

```toml
[access_scopes]
scopes = "read_products,write_products,read_inventory,write_inventory,read_orders,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects"
```

Merchants will be prompted to re-approve scopes on next app load.

### 1b. Ensure Metaobject Definition Exists (Runtime, GraphQL)

Create a setup service that runs on app authenticate. It checks whether the `product_relationship` metaobject definition already exists, and creates it if not.

**Check**:

```graphql
query {
  metaobjectDefinitionByType(type: "product_relationship") {
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
```

**Create** (if not found):

```graphql
mutation {
  metaobjectDefinitionCreate(
    definition: {
      type: "product_relationship"
      name: "Product Relationship"
      description: "Links a child product variant with a quantity for bundle composition"
      access: { storefront: PUBLIC_READ }
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
    }
  ) {
    metaobjectDefinition {
      id
    }
    userErrors {
      field
      message
    }
  }
}
```

This is merchant-owned (no `$app:` prefix), so it's globally visible in the Shopify admin and accessible to all apps. If the definition already exists (e.g., created manually or by a previous install), the check prevents a duplicate error.

> **Future (public app)**: Switch to TOML-declared `$app:product_relationship` for automatic deployment. The TOML approach ensures the definition is consistent across all installations and version-controlled with the app code.

### 1c. Ensure Metafield Definition Exists (Runtime)

Also on app authenticate, ensure a metafield definition exists on `ProductVariant` for attaching the metaobject list:

- **Namespace**: `$app:spicy_pickle` (app-reserved — only this app can write it)
- **Key**: `bundle_children`
- **Type**: `list.metaobject_reference` (referencing `product_relationship`)
- **Owner type**: `PRODUCTVARIANT`

Use `metafieldDefinitionCreate` GraphQL mutation with idempotent "already exists" handling.

> **Ownership split**: The `product_relationship` metaobject is merchant-owned (global, any app can read/write entries). The `$app:spicy_pickle.bundle_children` metafield that attaches those metaobjects to specific variants is app-reserved (only Spicy Pickle can write the attachment).

**File**: `app/services/metaobject-setup.server.ts`

---

## Phase 2: Metaobject Service Layer

Create `app/services/metaobjects.server.ts` with the following capabilities:

### 2a. Read Operations

- **`getRelationshipsForVariant(admin, variantGid)`**: Query the parent variant's `$app:spicy_pickle.bundle_children` metafield, resolve the referenced metaobjects, return `Array<{ metaobjectGid, childGid, quantity }>`.
- **`findVariantsReferencingChild(admin, childVariantGid)`**: Query `metaobjects(type: "product_relationship")` filtered by `child == childVariantGid`, then reverse-lookup which variants reference those metaobjects. (Used for migration/admin, NOT for inventory sync hot path.)

### 2b. Write Operations

- **`createRelationship(admin, childGid, quantity)`**: Create a `product_relationship` metaobject entry. Returns the new metaobject GID.
- **`updateRelationship(admin, metaobjectGid, { childGid?, quantity? })`**: Update an existing entry.
- **`deleteRelationship(admin, metaobjectGid)`**: Delete an entry.
- **`attachRelationshipsToVariant(admin, variantGid, metaobjectGids[])`**: Set the variant's `$app:spicy_pickle.bundle_children` metafield to the given list of metaobject GIDs.
- **`detachRelationshipsFromVariant(admin, variantGid)`**: Clear the metafield (remove all associations).

### 2c. Bulk Operations

- **`createBundleAsMetaobjects(admin, parentVariantGid, children[])`**: Create multiple metaobject entries + attach all to the parent variant in a single logical operation. Used by Quick Setup and bundle creation UI.
- **`deleteBundleMetaobjects(admin, parentVariantGid)`**: Detach + delete all relationship metaobjects for a parent variant.

---

## Phase 3: Sync Layer (Metaobject → Prisma Cache)

### 3a. Sync Service

Create `app/services/metaobject-sync.server.ts`:

- **`syncMetaobjectsToPrisma(admin, shop)`**: Full sync. Query all `product_relationship` metaobjects for the shop, resolve which variants they're attached to, then upsert Bundle + BundleChild rows in Prisma. Delete any Prisma bundles that no longer exist as metaobjects.
- **`syncSingleVariant(admin, shop, variantGid)`**: Sync just one variant's metaobject relationships to Prisma. Used after creating/updating a bundle via the app UI.

### 3b. Sync Triggers

| Trigger                                    | Action                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| App authenticate (page load)               | Run `syncMetaobjectsToPrisma` if last sync > 5 minutes ago (store timestamp in Shop model or a SyncState table) |
| Bundle created/updated via Spicy Pickle UI | Write to metaobjects, then `syncSingleVariant` to update Prisma                                                 |
| Bundle created/updated via Shopify admin   | Caught on next app authenticate sync                                                                            |
| Manual "Refresh" button in UI              | Run `syncMetaobjectsToPrisma` on demand                                                                         |

### 3c. Schema Addition

Add a sync timestamp to track freshness:

```prisma
model Shop {
  id                     String        @id
  createdAt              DateTime      @default(now())
  updatedAt              DateTime      @updatedAt
  bundles                Bundle[]
  binLocations           BinLocation[]
  supplierSkus           SupplierSku[]
  lastMetaobjectSyncAt   DateTime?     // Track when metaobjects were last synced to Prisma
}
```

### 3d. Source of Truth Hierarchy

1. **Metaobjects** are the canonical source of bundle composition
2. **Prisma** is the read cache for hot-path operations (inventory sync, pick list)
3. **The JSON metafield** (`spicy_pickle.bundle_config`) is deprecated and eventually removed

---

## Phase 4: Update Bundle UI to Write Metaobjects

### 4a. Bundle Creation (`app/routes/app.bundles.new.tsx`)

**Before**: Creates Bundle + BundleChild rows in Prisma, then syncs JSON metafield.

**After**:

1. Create `product_relationship` metaobject entries via `createBundleAsMetaobjects`
2. Sync to Prisma via `syncSingleVariant`
3. (No more JSON metafield sync)

### 4b. Bundle Edit (`app/routes/app.bundles.$id.tsx`)

**Before**: Updates Prisma rows, syncs JSON metafield.

**After**:

1. Update/create/delete metaobject entries as needed
2. Re-attach the updated list to the variant
3. Sync to Prisma

### 4c. Bundle Delete

**Before**: Deletes Prisma rows, deletes JSON metafield.

**After**:

1. Delete metaobject entries via `deleteBundleMetaobjects`
2. Delete Prisma cache rows

### 4d. Quick Setup (`app/routes/app.bundles.quick-setup.tsx`)

Same pattern: create metaobjects first, then sync to Prisma.

### 4e. CSV Import (`app/routes/app.bundles.import.tsx`)

Parse CSV → create metaobject entries in bulk → sync to Prisma.

### 4f. CSV Export (`app/routes/app.bundles.export.tsx`)

Read from Prisma cache (fast), same as current. Alternatively, read from metaobjects for guaranteed freshness.

---

## Phase 5: Inventory Sync (No Changes to Hot Path)

The critical path in `app/services/inventory-sync.server.ts` is **unchanged**:

1. Webhook fires → `processInventoryUpdate`
2. `findBundlesForVariant` → reads from **Prisma** (fast, indexed)
3. Calculate adjustments → `adjustInventoryLevels`

The only difference is that Prisma data now originates from metaobjects instead of being the primary store. The inventory sync code doesn't need to know or care about this change.

**Pick list** (`app/services/picklist.server.ts`) is also unchanged — it reads `expandOnPick` bundles from Prisma.

---

## Phase 6: Migration Page

A toggle-able admin page that reads existing `bundle_base` / `bundle_quant` variant metafields and generates `product_relationship` metaobject entries for each product.

**Route**: `app/routes/app.admin.migrate.tsx`
**Toggle**: Controlled via a feature flag or nav link that can be shown/hidden in `app/routes/app.tsx`.

### 6a. Data Source: Existing Variant Metafields

Every variant in the store may have two metafields (set up outside the app):

| Metafield      | Type    | Meaning                                                                    |
| -------------- | ------- | -------------------------------------------------------------------------- |
| `bundle_base`  | Boolean | `True` = this is the base unit of the product (e.g., 330ml Single Can)     |
| `bundle_quant` | Integer | How many base units this variant represents (e.g., 4-Pack = 4, Single = 1) |

Example for Pernicious Weed:

| Variant               | bundle_quant | bundle_base |
| --------------------- | ------------ | ----------- |
| 330ml Single Can      | 1            | True        |
| 4-Pack                | 4            | False       |
| 6-Pack                | 6            | False       |
| 24-Pack               | 24           | False       |
| 6-Pack (Subscription) | 1            | False       |
| Pernicious Hazy 6+1   | 1            | True        |

### 6b. Migration Algorithm (Per Product)

```
1. Fetch all variants for the product with their bundle_base and bundle_quant metafields
2. Identify base variant(s): variants where bundle_base == "True"
3. Validate:
   a. If 0 base variants found → report "NO_BASE" error, skip product
   b. If >1 base variants found → report "MULTIPLE_BASES" error, skip product
      (e.g., Pernicious Weed has both "Single Can" and "Hazy 6+1" marked as base)
   c. If any non-base variant is missing bundle_quant → report "MISSING_QUANT" error, skip product
4. For each non-base variant:
   a. Create a product_relationship metaobject entry:
      - child = base variant GID
      - quantity = this variant's bundle_quant
   b. Attach the metaobject to this variant via $app:spicy_pickle.bundle_children metafield
5. Sync the created relationships to Prisma cache
6. Mark product as migrated
```

### 6c. Migration Page UI

**Layout**: Full-page table with product-level rows.

#### Product List Table

| Product             | Variants | Base Variant                             | Status         | Actions |
| ------------------- | -------- | ---------------------------------------- | -------------- | ------- |
| Pernicious Weed     | 6        | ⚠️ Multiple bases (Single Can, Hazy 6+1) | **Ambiguous**  | Review  |
| Hāpi Daze           | 4        | Single 330ml                             | **Ready**      | Migrate |
| Iron Pig            | 3        | Single 330ml                             | **Migrated** ✓ | View    |
| Wild Rumpus Feb '26 | 1        | — (no base)                              | **No Base**    | Review  |

#### Status Values

| Status           | Meaning                                                                                   | Color  |
| ---------------- | ----------------------------------------------------------------------------------------- | ------ |
| **Ready**        | Exactly 1 base variant, all non-base variants have `bundle_quant`. Can auto-migrate.      | Blue   |
| **Migrated**     | Product already has `product_relationship` metaobjects attached to its non-base variants. | Green  |
| **Ambiguous**    | Multiple `bundle_base=True` variants detected. Needs manual review.                       | Yellow |
| **No Base**      | No variant has `bundle_base=True`. Needs manual configuration or is a mixed pack.         | Yellow |
| **Missing Data** | Some variants lack `bundle_quant` metafield. Incomplete configuration.                    | Yellow |
| **Error**        | Server error during migration attempt. Shows error message.                               | Red    |
| **Skipped**      | Only 1 variant in the product — nothing to bundle.                                        | Grey   |

#### Actions

- **Migrate** (per product): Runs the migration algorithm for a single product. Button only shown for "Ready" status.
- **Migrate All**: Iterates through all "Ready" products and migrates them sequentially. Shows a progress indicator (e.g., "Migrating 12/45...").
- **Review**: Opens a detail view showing the product's variants, their metafield values, and the detected issue. Allows manual override (e.g., select which variant is the true base).
- **View**: For already-migrated products, shows the created `product_relationship` metaobjects.
- **Refresh**: Re-scans all products to update statuses.

#### Bulk Migration Flow

When "Migrate All" is clicked:

1. Filter products to only those with status "Ready"
2. Process sequentially (to respect API rate limits)
3. After each product, update its row status in real-time (Ready → Migrated or → Error)
4. On completion, show summary:
   - ✓ X products migrated successfully
   - ⚠️ Y products skipped (ambiguous/no base/missing data)
   - ✗ Z products failed (with error details)

#### Error Report

Persistent error log at the bottom of the page (or expandable panel):

```
[2026-03-25 14:32:01] Pernicious Weed — MULTIPLE_BASES: Found 2 base variants:
  "330ml Single Can" (gid://shopify/ProductVariant/123)
  "Pernicious Hazy 6+1" (gid://shopify/ProductVariant/789)
  → Manual review required

[2026-03-25 14:32:03] Wild Rumpus Feb '26 — NO_BASE: No variant has bundle_base=True
  → This may be a mixed pack requiring manual product_relationship setup

[2026-03-25 14:32:05] Some Product — API_ERROR: Rate limited (429)
  → Will retry on next "Migrate All" run
```

### 6d. Known Edge Cases

| Case                                                   | Detection                                                                   | Handling                                                                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multiple base variants** (e.g., Pernicious Weed 6+1) | >1 variant with `bundle_base=True`                                          | Flag as "Ambiguous". The 6+1 is a cross-product bundle that can't be auto-migrated from single-product metafields. Needs manual `product_relationship` setup with children from multiple products. |
| **Mixed packs** (e.g., Wild Rumpus)                    | 0 variants with `bundle_base=True`, or product is a known mixed pack        | Flag as "No Base". These have no single base variant — they contain children from other products. Must be configured manually via the bundle UI or Shopify admin.                                  |
| **Subscription/activation variants**                   | `bundle_quant=1` and `bundle_base=False`                                    | Migrated as-is (creates a relationship: child=base, quantity=1). May want a "skip subscription variants" option later.                                                                             |
| **Single-variant products**                            | Product has only 1 variant                                                  | Status "Skipped" — nothing to bundle.                                                                                                                                                              |
| **Already migrated**                                   | Variant already has `$app:spicy_pickle.bundle_children` metafield populated | Status "Migrated" — don't re-migrate. Show existing relationships.                                                                                                                                 |
| **Partial migration**                                  | Some variants migrated, others not                                          | Status "Partially Migrated" — show which variants still need migration.                                                                                                                            |

### 6e. Toggle Visibility

In `app/routes/app.tsx`, wrap the "Migration" nav link in a feature flag:

```typescript
const SHOW_MIGRATION_PAGE = true; // Set to false to hide from nav after migration is complete
```

Or use an environment variable (`ENABLE_MIGRATION=true`) so it can be toggled per deployment without code changes.

### 6f. Deprecate JSON Metafield

After migration is verified for all products:

1. Stop writing `spicy_pickle.bundle_config` JSON metafields
2. Remove `syncBundleMetafield` / `deleteBundleMetafield` calls
3. Optionally clean up existing JSON metafields via bulk delete

---

## Phase 7: Deprecate JSON Metafield Sync

Remove from codebase:

- `syncBundleMetafield` function in `app/services/metafields.server.ts`
- `deleteBundleMetafield` function
- `syncAllBundleMetafields` function
- All call sites in bundle routes and API routes
- The `BundleConfig` type (replaced by metaobject structure)

Keep `metafields.server.ts` for bin location metafields (unchanged).

---

## Phase 8: Testing

- Unit tests for metaobject service (CRUD operations)
- Unit tests for sync service (metaobject → Prisma)
- Integration test: create bundle via metaobjects → verify Prisma cache → trigger inventory webhook → verify sync still works
- Migration test: existing Prisma bundles → metaobjects → back to Prisma cache → verify parity

---

## Performance Analysis

| Operation                    | Current                           | After Migration                        | Change                                   |
| ---------------------------- | --------------------------------- | -------------------------------------- | ---------------------------------------- |
| Inventory webhook (hot path) | Prisma lookup (~1ms)              | Prisma lookup (~1ms)                   | **None**                                 |
| Bundle creation (UI)         | 1 Prisma write + 1 metafield sync | 2-3 GraphQL calls + 1 Prisma write     | Slightly slower (acceptable, infrequent) |
| Bundle list (UI)             | Prisma read + variant title fetch | Prisma read + variant title fetch      | **None**                                 |
| Pick list generation         | Prisma read                       | Prisma read                            | **None**                                 |
| App page load                | None                              | Conditional metaobject sync (if stale) | Adds ~1-2s on stale cache                |

The hot path (inventory sync) sees **zero performance change**. The only added latency is on bundle creation (a few extra API calls) and occasional background cache refreshes on app load. Both are acceptable.

---

## Scope Changes Summary

### New Scopes Required

```
read_metaobject_definitions, write_metaobject_definitions,
read_metaobjects, write_metaobjects
```

### New Files

| File                                      | Purpose                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `app/services/metaobject-setup.server.ts` | Ensure metaobject definition + metafield definition exist on app load |
| `app/services/metaobjects.server.ts`      | CRUD for product_relationship metaobject entries                      |
| `app/services/metaobject-sync.server.ts`  | Sync metaobjects → Prisma cache                                       |
| `app/services/migration.server.ts`        | Migration logic: read bundle_base/bundle_quant, generate metaobjects  |
| `app/routes/app.admin.migrate.tsx`        | Migration page UI (toggle-able)                                       |

### Modified Files

| File                                     | Change                                       |
| ---------------------------------------- | -------------------------------------------- |
| `shopify.app.toml`                       | Add metaobject/metafield scopes              |
| `prisma/schema.prisma`                   | Add `lastMetaobjectSyncAt` to Shop           |
| `app/routes/app.tsx`                     | Add toggle-able "Migration" nav link         |
| `app/routes/app.bundles.new.tsx`         | Write metaobjects instead of Prisma-first    |
| `app/routes/app.bundles.$id.tsx`         | Write metaobjects instead of Prisma-first    |
| `app/routes/app.bundles.quick-setup.tsx` | Write metaobjects instead of Prisma-first    |
| `app/routes/app.bundles.import.tsx`      | Create metaobjects from CSV                  |
| `app/routes/api.bundles.tsx`             | Write metaobjects + sync cache               |
| `app/routes/api.bundles.$id.tsx`         | Write metaobjects + sync cache               |
| `app/services/metafields.server.ts`      | Eventually remove bundle metafield functions |

### Unchanged Files (Hot Path)

| File                                    | Why                                 |
| --------------------------------------- | ----------------------------------- |
| `app/services/inventory-sync.server.ts` | Still reads from Prisma — no change |
| `app/services/picklist.server.ts`       | Still reads from Prisma — no change |
| `app/routes/webhooks.inventory.tsx`     | No change                           |

---

## Relationship to Existing Plans

This plan **replaces Phase 2's metafield sync approach** from `BUNDLE_REFINEMENT_PLAN.md`. The Bundle and BundleChild Prisma models remain but become a cache rather than the source of truth. All other phases (table UI, quick setup, supplier SKUs, CSV import/export) are compatible and can proceed in parallel.
