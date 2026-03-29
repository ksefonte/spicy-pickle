# Bin Locations Redesign Plan

## Summary

Redesign the bin location system from a flat variant → location string mapping to a structured, multi-variant bin model with descriptions, ordering, and product-level assignment. This feeds into the pick list service and a future stock visualiser.

---

## Current State

The existing `BinLocation` model is minimal:

```prisma
model BinLocation {
  id         String   @id @default(cuid())
  shopId     String
  variantGid String
  location   String   // free-form string like "A1-03"
  @@unique([shopId, variantGid])
}
```

**Limitation:** One variant → one location string. No concept of a "bin" as an entity that contains multiple variants. No ordering, no descriptions.

**Existing route:** `app.locations._index.tsx` — a flat table of variant → location pairs with search, create, update, delete. Also syncs to `spicy_pickle.bin_location` metafield.

---

## New Data Model

### Schema

```prisma
/// A named physical bin/location in the warehouse
model Bin {
  id          String       @id @default(cuid())
  shopId      String
  shop        Shop         @relation(fields: [shopId], references: [id], onDelete: Cascade)
  name        String       // Short label: "A1-03", "Cold Room", "Poster Shelf"
  description String?      // Optional longer description
  sortOrder   Int          @default(0)  // For manual ordering in UI
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  variants    BinVariant[]

  @@unique([shopId, name])
  @@index([shopId])
}

/// A variant assigned to a bin (one bin per variant per shop, enforced at DB level)
model BinVariant {
  id         String   @id @default(cuid())
  binId      String
  bin        Bin      @relation(fields: [binId], references: [id], onDelete: Cascade)
  shopId     String   // Denormalized from Bin for unique constraint
  variantGid String   // Shopify Product Variant GID
  createdAt  DateTime @default(now())

  @@unique([shopId, variantGid])  // DB-level: one bin per variant per shop
  @@unique([binId, variantGid])   // Prevents duplicate within same bin
  @@index([variantGid])
}
```

**Key design decisions:**

1. **One bin per variant (DB-enforced)**: The `@@unique([shopId, variantGid])` constraint on `BinVariant` guarantees at the database level that a variant can only exist in one bin per shop. The `shopId` field is denormalized from the parent `Bin` to make this constraint possible. When a variant is assigned to a new bin, the app deletes the old `BinVariant` row first (or uses an upsert pattern). This makes pick list reporting unambiguous — there's a single definitive location for each item. For products where all variants live together, assign them all to one bin. For products where singles and packs are stored separately (e.g., loose cans in Bin 4, 6-packs in Bin 5), assign those specific variants to different bins.
2. **Bin as first-class entity**: Has its own name, description, sort order.
3. **Sort order**: Integer field for reordering in the UI. This directly feeds into pick list sorting — items are sorted by their bin's `sortOrder`, not alphabetically.
4. **Drop `BinLocation` table**: The old model is deleted entirely in the same migration (no transition period needed since there is no meaningful data in the current database).

### Relationship to Shop

Add to the Shop model:

```prisma
model Shop {
  ...existing fields...
  bins         Bin[]
}
```

### Migration from BinLocation → Bin + BinVariant

No data migration needed — the `BinLocation` table contains no meaningful data at this stage. The Prisma migration will:

1. Create the `Bin` and `BinVariant` tables
2. Drop the `BinLocation` table
3. Remove the `binLocations` relation from `Shop`

This is a clean replacement, not a data migration.

---

## UI Design

### Route: `app/routes/app.locations._index.tsx` (rewrite)

**URL:** `/app/locations` (same URL, new content)

```
┌──────────────────────────────────────────────────────────┐
│ Bin Locations                               [+ New Bin]  │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  Bins are ordered — drag to reorder or use arrows.        │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ⬍ A1-01 — Cold room loose cans           [3 SKUs] │  │
│  │   ├ Hāpi Daze - 330ml Single Can (HD-330)          │  │
│  │   ├ Pernicious Weed - 330ml Single Can (PW-330)    │  │
│  │   └ Pils - 330ml Single Can (PILS-330)             │  │
│  │                                 [+ Add Variants]   │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ ⬍ A1-02 — Cold room 4-packs              [2 SKUs] │  │
│  │   ├ Hāpi Daze - 4 Pack (HD-4PK)                   │  │
│  │   └ Pernicious Weed - 4 Pack (PW-4PK)             │  │
│  │                                 [+ Add Variants]   │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ ⬍ B2-01 — Poster storage                 [0 SKUs] │  │
│  │   (empty)                                           │  │
│  │                                 [+ Add Variants]   │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### Bin Card — Expanded View

Each bin card shows:

- **Name** (editable inline or via modal)
- **Description** (shown below name, editable)
- **Variant count badge**
- **Variant list** with product title, variant title, SKU
- **Remove variant** button (✕) per variant
- **"+ Add Variants"** button → opens variant picker
- **Drag handle / Up-Down arrows** for reordering
- **Edit / Delete** actions on the bin itself

### Adding Variants

Two modes for adding variants to a bin:

1. **Individual variant picker**: Uses Shopify resource picker (`type: "variant"`, `multiple: true`) to select specific variants
2. **Add all variants of a product**: Uses Shopify resource picker (`type: "product"`, `multiple: false`), then fetches all variants and adds them all to the bin

The "Add Variants" button opens a choice:

```
[Select Individual Variants]  [Add All from a Product]
```

### Creating a New Bin

Modal or inline form:

- **Name** (required) — short identifier like "A1-03"
- **Description** (optional) — longer text like "Cold room floor, loose cans"
- Bin is created with `sortOrder = max(existing) + 1`

### Reordering

Bins are displayed in `sortOrder` ascending. Reordering options:

- Up/Down arrow buttons (simple, accessible)
- Save button commits the new order via a `reorder` action that bulk-updates `sortOrder`

---

## Actions

| Intent           | Parameters                            | Effect                              |
| ---------------- | ------------------------------------- | ----------------------------------- |
| `create_bin`     | `name`, `description?`                | Creates a new Bin                   |
| `update_bin`     | `binId`, `name?`, `description?`      | Updates bin metadata                |
| `delete_bin`     | `binId`                               | Deletes bin and all BinVariant rows |
| `add_variants`   | `binId`, `variantGids` (JSON array)   | Creates BinVariant rows             |
| `remove_variant` | `binId`, `variantGid`                 | Deletes a BinVariant row            |
| `reorder`        | `order` (JSON: `[{ id, sortOrder }]`) | Bulk-updates sortOrder              |

---

## Migration Modal Integration

In the product detail modal on the Migration page:

- Show which bins each variant belongs to (read-only display)
- This provides visibility without requiring users to leave the migration workflow

---

## Metafield Sync

The existing `syncBinLocationMetafield` writes a `spicy_pickle.bin_location` string metafield per variant. With the new one-bin-per-variant model, this metafield can continue to hold a single bin name string if needed.

**Recommendation:** Keep metafield sync as a secondary concern. The pick list and stock visualiser will read from Prisma. The `syncBinLocationMetafield` / `deleteBinLocationMetafield` functions in `metafields.server.ts` can be updated later to write the new `Bin.name` value, or deprecated entirely if no external system reads the metafield.

---

## Route Migration (BinLocation → Bin + BinVariant)

Files that reference the old `BinLocation` model and need updating:

| File                                  | Current Usage                                                                             | Migration Action                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                | `BinLocation` model, `Shop.binLocations` relation                                         | Drop `BinLocation`, remove relation, add `Bin` + `BinVariant` + `Shop.bins`                         |
| `app/routes/app.locations._index.tsx` | CRUD on `db.binLocation`, calls `syncBinLocationMetafield` / `deleteBinLocationMetafield` | **Full rewrite** to new bin-card UI using `Bin` + `BinVariant`                                      |
| `app/routes/app.locations.import.tsx` | CSV import writing `db.binLocation.upsert`                                                | **Rewrite** to create `Bin` entries from unique locations and `BinVariant` entries for each variant |
| `app/services/metafields.server.ts`   | `syncBinLocationMetafield`, `deleteBinLocationMetafield`                                  | Keep for now (metafield sync is a secondary concern); update to write `Bin.name` later              |
| `app/services/picklist.server.ts`     | `db.binLocation.findMany` in `addBinLocations()`, `binLocation` field on `PickListItem`   | **Update** to join through `BinVariant` → `Bin`, rename field to `binName`, add `binSortOrder`      |
| `app/routes/app.picklist._index.tsx`  | Displays `item.binLocation`, sorts by `"binLocation"`                                     | **Update** to use `binName`, `binSortOrder`                                                         |
| `app/routes/api.debug.tsx`            | `db.binLocation.count()`                                                                  | **Update** to `db.bin.count()` and `db.binVariant.count()`                                          |

## Implementation Phases

| Phase | Task                                                             | Effort |
| ----- | ---------------------------------------------------------------- | ------ |
| 1     | Schema: create `Bin` + `BinVariant`, drop `BinLocation`, migrate | Low    |
| 2     | Bin CRUD: create/edit/delete bins with name + description        | Medium |
| 3     | Variant assignment: add/remove variants with resource picker     | Medium |
| 4     | Reordering: sortOrder management with up/down arrows             | Low    |
| 5     | Product-level add: "Add all variants from product" flow          | Low    |
| 6     | Pick list integration: update pick list to use new Bin model     | Medium |
| 7     | (Optional) Metafield sync update                                 | Low    |

---

## Navigation

The existing "Bin Locations" nav link at `/app/locations` will remain. The route is rewritten in place.

---

## Future: Stock Visualiser

The bin model is designed to support a future stock visualiser that shows:

- Physical layout of bins with their contents
- Current stock levels per bin (via inventory API)
- Visual indicators for low stock, overstock, etc.

The `Bin.sortOrder` and `Bin.description` fields support this by providing spatial/organisational context beyond just a location code.
