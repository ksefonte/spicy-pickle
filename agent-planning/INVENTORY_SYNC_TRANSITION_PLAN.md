# Inventory Sync Transition Plan

## Context

The migration system now creates `product_relationship` metaobjects in Shopify and attaches them to variants via the `custom.product_relationships` metafield (a `list.metaobject_reference` on ProductVariant). The migration also writes corresponding `Bundle` / `BundleChild` rows in Prisma so the existing inventory sync continues to work.

This document plans how to fully transition the inventory sync to use the metaobject system as the source of truth while keeping Prisma as the performance cache.

---

## Current State (Post-Migration)

### Data Flow

```
                    ┌─────────────────────┐
                    │  Shopify Admin /     │
                    │  Migration Page      │
                    └──────┬──────────────┘
                           │ writes
                           ▼
    ┌──────────────────────────────────────────────┐
    │  Shopify Metaobjects                         │
    │  product_relationship (merchant-owned)        │
    │    ├─ variant_reference field (child)         │
    │    └─ number_integer field (quantity)         │
    │                                              │
    │  custom.product_relationships                │
    │    └─ list.metaobject_reference on Variant   │
    └──────────────────────────────────────────────┘
                           │
                           │ migration writes both
                           ▼
    ┌──────────────────────────────────────────────┐
    │  Prisma (operational cache)                  │
    │  Bundle                                      │
    │    ├─ parentGid (non-base variant)           │
    │    ├─ parentTitle, parentSku                 │
    │    └─ children[] → BundleChild               │
    │         ├─ childGid (base variant)           │
    │         └─ quantity                          │
    └──────────────────────┬───────────────────────┘
                           │ read by
                           ▼
    ┌──────────────────────────────────────────────┐
    │  Inventory Sync    │   Pick List             │
    │  (webhook handler) │   (order processing)    │
    │  Reads Prisma      │   Reads Prisma          │
    └──────────────────────────────────────────────┘
```

### What Works Today

- **Migration page** creates metaobjects + Prisma rows in a single operation
- **Inventory sync** reads from Prisma `Bundle` / `BundleChild` (unchanged, fast)
- **Pick list** reads from Prisma (unchanged)
- **Metaobject field keys** are discovered dynamically at startup via `getMetaobjectFieldMap()`, so the code adapts to whatever field names exist on the definition

### What Doesn't Work Yet

- Bundles created via the **Bundles tab** (CRUD) don't create metaobjects
- Metaobjects created/edited directly in **Shopify admin** aren't reflected in Prisma
- No periodic sync to catch external changes
- The old `spicy_pickle.bundle_config` JSON metafield is still being written by some routes

---

## Phase 1: Background Sync (Metaobjects → Prisma)

Implement a sync service that keeps Prisma in sync with Shopify metaobjects.

### 1a. Sync Service

**File**: `app/services/metaobject-sync.server.ts`

```
syncMetaobjectsToPrisma(admin, shopId):
  1. Query all product_relationship metaobjects from Shopify
  2. For each metaobject, resolve which variant references it
     (via custom.product_relationships metafield)
  3. Upsert Bundle + BundleChild rows in Prisma
  4. Delete any Prisma bundles whose metaobjects no longer exist
  5. Update Shop.lastMetaobjectSyncAt timestamp
```

### 1b. Sync Triggers

| Trigger                 | Action                                         |
| ----------------------- | ---------------------------------------------- |
| App page load (loader)  | Sync if `lastMetaobjectSyncAt` > 5 minutes ago |
| After migration         | Already handled (writes both)                  |
| Manual "Refresh" button | Full sync on demand                            |
| Shopify admin edit      | Caught on next page load sync                  |

### 1c. Schema Addition

```prisma
model Shop {
  // ... existing fields
  lastMetaobjectSyncAt   DateTime?
}
```

---

## Phase 2: Update Bundle CRUD to Write Metaobjects

Redirect all bundle creation/editing to write metaobjects first, then sync to Prisma.

### Routes to Update

| Route                         | Current Behaviour                    | New Behaviour                                |
| ----------------------------- | ------------------------------------ | -------------------------------------------- |
| `app.bundles.new.tsx`         | Writes Prisma, syncs JSON metafield  | Creates metaobjects, syncs to Prisma         |
| `app.bundles.$id.tsx`         | Updates Prisma, syncs JSON metafield | Updates metaobjects, syncs to Prisma         |
| `app.bundles.quick-setup.tsx` | Writes Prisma, syncs JSON metafield  | Creates metaobjects, syncs to Prisma         |
| `app.bundles.import.tsx`      | Writes Prisma only                   | Creates metaobjects, syncs to Prisma         |
| `api.bundles.tsx`             | Writes Prisma                        | Creates metaobjects, syncs to Prisma         |
| `api.bundles.$id.tsx`         | Writes Prisma                        | Updates/deletes metaobjects, syncs to Prisma |

### Write Pattern

```
createBundle(admin, shopId, parentVariantGid, children[]):
  1. For each child { childGid, quantity }:
     a. metaobjectCreate → product_relationship { child, quantity }
     b. Collect metaobject GIDs
  2. metafieldsSet on parentVariantGid:
     custom.product_relationships = [metaobjectGid1, metaobjectGid2, ...]
  3. Upsert Bundle + BundleChild in Prisma
```

---

## Phase 3: Deprecate JSON Metafield

Once all routes write metaobjects:

1. Remove `syncBundleMetafield` / `deleteBundleMetafield` from `metafields.server.ts`
2. Remove all call sites in bundle routes
3. Optionally bulk-delete existing `spicy_pickle.bundle_config` metafields

---

## Phase 4: Inventory Sync — No Hot Path Changes

The inventory sync webhook handler (`inventory-sync.server.ts`) **does not change**. It continues to:

1. Receive inventory webhook → `processInventoryUpdate`
2. `findBundlesForVariant` → Prisma query (~1ms)
3. Calculate adjustments → `adjustInventoryLevels`

The Prisma cache is kept fresh by Phase 1's background sync and Phase 2's write-through pattern.

### Why Not Read Metaobjects Directly?

| Approach           | Latency per webhook | API calls      | Rate limit risk         |
| ------------------ | ------------------- | -------------- | ----------------------- |
| Prisma lookup      | ~1ms                | 0              | None                    |
| Metaobject GraphQL | ~200-500ms          | 2-3 per bundle | High during stock takes |

During stock takes (100+ inventory changes in rapid succession), reading from Shopify would consume significant API budget and add latency. Prisma is the right choice for the hot path.

---

## Phase 5: Consider Bundles Tab Consolidation

The Migration page has effectively superseded the Bundles tab for defining same-product relationships. Options:

### Option A: Keep Both (Recommended Short Term)

- **Migration tab**: Bulk auto-configuration from `bundle_base` / `bundle_quant` metafields
- **Bundles tab**: Manual configuration, mixed packs, fine-tuning
- Both write to metaobjects → Prisma

### Option B: Merge into Single "Relationships" Tab

- Replace both with a unified UI
- Product list with expandable variant configuration
- Auto-detect from metafields + manual override
- Would require significant UI work

### Option C: Read-Only Bundles Tab

- Bundles tab becomes read-only, showing data from Prisma
- All editing happens in Shopify admin (metaobject entries) or via the Migration page
- Simplest to implement but loses in-app editing

**Recommendation**: Option A for now. The Bundles tab handles mixed packs and `expandOnPick` (which doesn't exist in metaobjects), so it still has a role. Transition to Option B as the app matures.

---

## Implementation Priority

| Priority  | Task                                          | Effort | Impact                                     |
| --------- | --------------------------------------------- | ------ | ------------------------------------------ |
| **Done**  | Migration writes both metaobjects + Prisma    | —      | Inventory sync works for migrated products |
| **Done**  | Dynamic field key discovery                   | —      | Adapts to any metaobject definition        |
| **Done**  | Post-migration product refresh + cache update | —      | UI reflects changes immediately            |
| **Next**  | Background sync (metaobjects → Prisma)        | Medium | Catches external edits                     |
| **Next**  | Update Bundle CRUD to write metaobjects       | Medium | Single source of truth                     |
| **Later** | Deprecate JSON metafield                      | Low    | Cleanup                                    |
| **Later** | Bundles tab consolidation                     | High   | UX improvement                             |

---

## Metafield Reference

| Metafield             | Namespace            | Key                     | Type                        | Owner              | Purpose                                                |
| --------------------- | -------------------- | ----------------------- | --------------------------- | ------------------ | ------------------------------------------------------ |
| Product Relationships | `custom`             | `product_relationships` | `list.metaobject_reference` | Merchant (Variant) | Attaches product_relationship metaobjects to a variant |
| Bundle Base           | `custom` or `global` | `bundle_base`           | `boolean`                   | Merchant (Variant) | Legacy: marks the base unit variant                    |
| Bundle Quant          | `custom` or `global` | `bundle_quant`          | `number_integer`            | Merchant (Variant) | Legacy: how many base units this variant represents    |
| Bundle Config         | `spicy_pickle`       | `bundle_config`         | `json`                      | App (Variant)      | **Deprecated**: old JSON-based bundle definition       |
