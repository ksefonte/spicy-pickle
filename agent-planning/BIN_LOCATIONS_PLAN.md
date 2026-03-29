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

/// A variant assigned to a bin (one bin per variant per shop)
model BinVariant {
  id         String   @id @default(cuid())
  binId      String
  bin        Bin      @relation(fields: [binId], references: [id], onDelete: Cascade)
  variantGid String   // Shopify Product Variant GID
  createdAt  DateTime @default(now())

  @@unique([binId, variantGid])
  @@index([variantGid])
}
```

**Key design decisions:**

1. **One bin per variant**: Each variant belongs to exactly one bin. This makes pick list reporting unambiguous — there's a single definitive location for each item. For products where all variants live together, assign them all to one bin. For products where singles and packs are stored separately (e.g., loose cans in Bin 4, 6-packs in Bin 5), assign those specific variants to different bins. If a variant is moved to a new bin, it's removed from the old one automatically.
2. **Bin as first-class entity**: Has its own name, description, sort order
3. **Sort order**: Integer field for reordering in the UI. This directly feeds into pick list sorting — items are sorted by their bin's `sortOrder`, not alphabetically.
4. **Replaced `BinLocation`**: The old model is superseded. Migration will convert existing data.

### Relationship to Shop

Add to the Shop model:

```prisma
model Shop {
  ...existing fields...
  bins         Bin[]
}
```

### Migration from BinLocation → Bin + BinVariant

For each unique `location` string in the existing `BinLocation` table:

1. Create a `Bin` with `name = location`
2. For each `BinLocation` row with that location string, create a `BinVariant` linking the variant to the new bin

After migration, the `BinLocation` table can be dropped.

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

The existing `syncBinLocationMetafield` writes a `spicy_pickle.bin_location` string metafield per variant. With the new model:

- A variant can be in multiple bins
- The metafield value could be updated to a comma-separated list of bin names, or a JSON array
- Or deprecated in favour of reading from Prisma (the pick list already reads from DB)

**Recommendation:** Keep metafield sync as a secondary concern. The pick list and stock visualiser will read from Prisma. The metafield sync can be updated later to write a JSON list if external systems need it.

---

## Implementation Phases

| Phase | Task                                                                  | Effort |
| ----- | --------------------------------------------------------------------- | ------ |
| 1     | Schema: create `Bin` + `BinVariant` models, migrate                   | Low    |
| 2     | Data migration: convert existing `BinLocation` → `Bin` + `BinVariant` | Low    |
| 3     | Bin CRUD: create/edit/delete bins with name + description             | Medium |
| 4     | Variant assignment: add/remove variants with resource picker          | Medium |
| 5     | Reordering: sortOrder management with up/down arrows                  | Low    |
| 6     | Product-level add: "Add all variants from product" flow               | Low    |
| 7     | Pick list integration: update pick list to use new Bin model          | Medium |
| 8     | (Optional) Metafield sync update                                      | Low    |

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
