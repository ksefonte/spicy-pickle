# Sync Configuration Plan

## Summary

Add a configuration system that allows the inventory sync service to be enabled/disabled at two levels:

1. **Global toggle** — a master on/off switch for the entire sync service
2. **Per-variant toggle** — fine-grained control over which variants participate in syncing

This enables a safe, incremental rollout: migrate product relationships first (no sync interference), then enable syncing product-by-product to validate correctness before switching entirely from the external syncer.

---

## Data Model

### Schema Changes

```prisma
model Shop {
  id                   String        @id
  createdAt            DateTime      @default(now())
  updatedAt            DateTime      @updatedAt
  lastMetaobjectSyncAt DateTime?
  syncEnabled          Boolean       @default(false)  // Global sync toggle
  bundles              Bundle[]
  bins                 Bin[]
  supplierSkus         SupplierSku[]
}
```

```prisma
model Bundle {
  id           String        @id @default(cuid())
  shopId       String
  shop         Shop          @relation(fields: [shopId], references: [id], onDelete: Cascade)
  parentGid    String
  parentTitle  String?
  parentSku    String?
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  children     BundleChild[]
  expandOnPick Boolean       @default(false)
  syncEnabled  Boolean       @default(false)  // NEW: per-bundle sync toggle

  @@unique([shopId, parentGid])
  @@index([shopId])
  @@index([parentGid])
}
```

This is simpler because:

- Only bundles need sync (non-bundle variants have nothing to sync)
- The toggle lives on the entity that drives the sync calculation
- No separate exclusion table needed
- Defaults to `false` so migration creates relationships without affecting existing syncing

---

## Sync Guard Logic

### In `processInventoryUpdate` (inventory-sync.server.ts)

```
processInventoryUpdate(admin, event):
  1. Resolve variant GID from inventory item
  2. findBundlesForVariant(shop, variantGid)
  3. For each bundle:
     a. NEW: Check shop.syncEnabled — if false, skip ALL
     b. NEW: Check bundle.syncEnabled — if false, skip THIS bundle
     c. Acquire lock, calculate adjustments, apply, release lock
```

The check is a single Prisma query that can be batched:

```typescript
const shop = await prisma.shop.findUnique({
  where: { id: event.shop },
  select: { syncEnabled: true },
});
if (!shop?.syncEnabled)
  return { processed: true, skipped: "Sync disabled globally" };
```

Then filter bundles:

```typescript
const activeBundles = bundles.filter((b) => b.syncEnabled);
```

### In `syncIfStale` (metaobject-sync.server.ts)

The background metaobject → Prisma sync should continue to run regardless of whether the inventory sync is enabled, since it keeps the Prisma cache current. Only the inventory adjustment step checks the toggles.

---

## Configuration Page

### Route: `app/routes/app.admin.config.tsx`

**URL:** `/app/admin/config`

**UI Layout:**

```
┌──────────────────────────────────────────────────────┐
│ Sync Configuration                                    │
├──────────────────────────────────────────────────────┤
│                                                       │
│  Global Sync                                          │
│  ┌─────────────────────────────────────────────┐     │
│  │ [Toggle: ON/OFF]  Inventory Sync Service     │     │
│  │                                               │     │
│  │ When enabled, inventory changes to child      │     │
│  │ variants automatically update parent bundle   │     │
│  │ availability.                                 │     │
│  └─────────────────────────────────────────────┘     │
│                                                       │
│  Bundle Sync Status                                   │
│  ┌─────────────────────────────────────────────┐     │
│  │ Search: [_________________]                   │     │
│  │ Filter: [All | Enabled | Disabled]            │     │
│  │                                               │     │
│  │ [Select All Visible] [Enable Selected]        │     │
│  │                      [Disable Selected]       │     │
│  │                                               │     │
│  │ ┌─────┬──────────────┬─────┬────────────┐   │     │
│  │ │ ☑   │ Bundle Name  │ SKU │ Sync       │   │     │
│  │ ├─────┼──────────────┼─────┼────────────┤   │     │
│  │ │ ☐   │ Hāpi Daze 4P │ HD4 │ [Disabled] │   │     │
│  │ │ ☑   │ Hāpi Daze 24 │ H24 │ [Enabled]  │   │     │
│  │ └─────┴──────────────┴─────┴────────────┘   │     │
│  └─────────────────────────────────────────────┘     │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Actions:**

- `toggle_global` — flips `shop.syncEnabled`
- `toggle_bundle` — flips `bundle.syncEnabled` for a single bundle
- `bulk_enable` — sets `syncEnabled = true` for selected bundle IDs
- `bulk_disable` — sets `syncEnabled = false` for selected bundle IDs

---

## Migration Page Integration

In the product detail modal (the relationship editor), add a section or toggle per variant:

- When viewing a product's variants and their relationships, show sync status
- Add a "Enable sync for all bundles in this product" / "Disable sync" button
- This provides the product-level control requested (affect sync product by product)

The modal would query bundles for the product's variants and show/toggle their `syncEnabled` status.

---

## Implementation Phases

| Phase | Task                                                              | Effort |
| ----- | ----------------------------------------------------------------- | ------ |
| 1     | Schema: add `Shop.syncEnabled`, `Bundle.syncEnabled`, migrate     | Low    |
| 2     | Guard: update `processInventoryUpdate` to check toggles           | Low    |
| 3     | Config page: global toggle + bundle list with bulk enable/disable | Medium |
| 4     | Migration modal: per-product sync toggle integration              | Low    |

---

## Navigation

Add to `app.tsx`:

```
<s-link href="/app/admin/config">Configuration</s-link>
```

Placed after Migration in the nav, potentially as an admin-only link (togglable like `SHOW_MIGRATION_PAGE`).
