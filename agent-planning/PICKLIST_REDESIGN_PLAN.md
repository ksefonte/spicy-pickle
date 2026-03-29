# Pick List Redesign Plan

## Summary

Redesign the pick list generator to support two presentation modes, bin-location-ordered sorting, an order manifest, Shopify admin integration (bulk order action), configurable filters, and a printable output format.

---

## Current State

The existing pick list (`picklist.server.ts` + `app.picklist._index.tsx`):

- Fetches orders by date range + status (unfulfilled/partial)
- Aggregates line items by variant, sums quantities
- Expands bundles where `expandOnPick = true`
- Joins with `BinLocation` table for location strings
- Sorts alphabetically by bin location string
- Outputs an in-app table with CSV export and `window.print()`

**Limitations:**

- Bin sorting is alphabetical (e.g., "01-CHCLEAR" < "02-CH4401") — this works accidentally because the old system uses numeric prefixes, but we want explicit user-defined ordering
- No "resolved to base units" mode
- No order manifest/summary
- No Shopify admin action integration
- No shipping/fulfillment line-item-level filters
- Print output is the app page with print CSS (not a dedicated printable view)

---

## Two Presentation Modes

### Mode 1: Standard Pick List (default)

Matches the current PDF format. Aggregates all line items across orders and sums by variant.

| QTY | SKU         | DESC                     | LOCATION   | PICKED |
| --- | ----------- | ------------------------ | ---------- | ------ |
| 14  | FTCAT-440-4 | Fat Cat 4-Pack           | 01-CHCLEAR | ☐      |
| 7   | FTCAT-440   | Fat Cat 440ml Single Can | 01-CHCLEAR | ☐      |

Items are sorted by bin `sortOrder` (from the new `Bin` model), then by product name within each bin. Bundles with `expandOnPick = true` are expanded to their components.

### Mode 2: Base Unit Resolution

Replaces non-base variants with their base unit equivalents using `product_relationship` data (from Prisma `Bundle` + `BundleChild`).

**Example:** 5 orders containing:

1. 1× Pweed 6-Pack (base unit = 330ml single, quantity = 6)
2. 4× Pweed Single Can
3. 1× Pweed 24-Pack (base unit = 330ml single, quantity = 24)
4. 2× Pweed 6-Pack + 1× Pweed Single Can
5. 1× Gift Pack containing 1× Pweed Single Can

**Resolved output:**

| QTY | SKU         | DESC                             | LOCATION      | PICKED |
| --- | ----------- | -------------------------------- | ------------- | ------ |
| 3   | PERNI-330-6 | Pernicious Weed 6-Pack           | 07-CHBACKWALL | ☐      |
| 29  | PERNI-330   | Pernicious Weed 330ml Single Can | 07-CHBACKWALL | ☐      |

**Resolution logic:**

- For each order line item, check if the variant is a bundle parent (has children in Prisma)
- If the bundle has a **single child** (same-product bundle like 4-Pack → 4× Single), resolve:
  - Keep the original line item as-is (the pack is a physical unit picked from its bin)
  - BUT also show the resolved base-unit total in a summary row
- If the bundle has **multiple children** (mixed pack), do NOT resolve — keep as-is since the pack is its own physical item
- The key insight: 6-packs are picked as 6-packs from the 6-pack bin. But the resolved view lets the warehouse know the total demand on base units for restocking purposes.

**Actually, re-reading the user's request more carefully:**

The user wants resolution to mean: "summarise as 3× 6-packs + 29× singles". This means:

- **Same-product bundles** where the ordered variant has a bundle relationship are grouped by their pack size
- The 3 6-packs stay as 6-packs (they're picked as physical 6-packs)
- The 24-pack gets resolved to 24× singles (because it's assembled from singles)
- Individual singles are summed

Wait — the user's example says "3× pweed 6-packs (2 + 1)" and "29× pweed single cans (24+4+1)". The 6-pack base unit IS the 6-pack, so orders of 6-packs remain as 6-packs. The 24-pack's base unit is the single can (330ml), so it resolves to 24 singles. The gift pack's pweed component is 1 single.

So the resolution logic is:

1. For each line item, look up its `Bundle` (where `parentGid = variant GID`)
2. If a Bundle exists, replace the line item with its children × quantities
3. Aggregate the resolved items by variant GID

This is essentially what `expandBundles` already does, but applied universally (not just for `expandOnPick = true` bundles).

**Mode 2 = Mode 1 but with ALL bundles expanded, not just expandOnPick ones.**

---

## Sorting by Bin Location Order

### Current

`sortItems` compares `binLocation` strings alphabetically.

### New

After the bin location redesign, each variant can be in one or more `Bin` entries. The `Bin` has a `sortOrder` field.

**Sort algorithm:**

1. For each pick list item, look up its bin (each variant has exactly one bin assignment)
2. Sort by `bin.sortOrder` ascending, then by product name ascending within the same bin
3. In the output, show the bin name instead of the raw location string

**Bin grouping in output:**

```
── A1-01: Cold room loose cans ──────────────────────
  14  FTCAT-440    Fat Cat 440ml Single Can       ☐
   7  PERNI-330    Pernicious Weed 330ml Single   ☐

── A1-02: Cold room 4-packs ────────────────────────
   3  FTCAT-440-4  Fat Cat 4-Pack                 ☐
   2  PERNI-330-4  Pernicious Weed 4-Pack         ☐

── (No bin assigned) ────────────────────────────────
   1  GIFTNOTE     Personalised Gift Note         ☐
```

---

## Order Manifest

At the end of the pick list output, include:

### Section 1: Order list

A numbered list of all order names included:

```
Order Manifest (18 orders)
──────────────────────────
GPWeb130149
GPWeb130150
...
GPWeb130182
```

### Section 2: Per-order contents

Each order with its line items:

```
GPWeb130149:
  1× Pōhutukawa Daze - 6-Pack (PHTKW-330-6)
  1× Spicy Pickle Beer - 4-Pack (SPICY-330-4)
  1× Good Shout - 6-Pack (GDSHO-330-6)

GPWeb130150:
  4× GP Bulb Pint - 400ml Pint (GBULB-GLASS-400)
  ...
```

This matches the format from pages 6-8 of the existing PDF.

---

## Shopify Admin Integration

### Admin Action Extension

Add a Shopify admin action that appears in the "More actions" menu on the Orders list page.

**`shopify.app.toml` addition:**

```toml
[extensions.admin_action]
  url = "/app/picklist/generate"
```

**Or via `extensions/` directory** (Shopify CLI app extension):

```
extensions/
  picklist-action/
    shopify.extension.toml
    src/
      ActionExtension.tsx
```

The extension config specifies:

- **Surface:** `admin.order-index.action.render` (orders list bulk action)
- **Name:** "Generate Pick List"

When the user selects orders and clicks "Generate Pick List":

1. The extension receives the selected order GIDs
2. It opens the app's pick list page with the order GIDs as query params
3. The pick list page auto-generates using those specific orders

**Alternative approach — App Bridge redirect:**

If the admin action extension is complex to set up, a simpler approach:

1. In the pick list page, add a "Fetch Outstanding Orders" button that pulls all unfulfilled orders automatically (no need to select from Shopify admin)
2. Add an "Order IDs" input field where users can paste specific order names/IDs

The admin action extension is the ideal UX but can be added as a Phase 2 enhancement.

---

## Filter Options

### Current filters

- Date range (start/end)
- Status: unfulfilled, partially fulfilled

### New filters

| Filter             | Options                                        | Default             |
| ------------------ | ---------------------------------------------- | ------------------- |
| Fulfillment status | Unfulfilled, Partially fulfilled, Fulfilled    | Unfulfilled ✓       |
| Requires shipping  | Requires shipping only, Local pickup only, All | Requires shipping ✓ |
| Date range         | Start date, End date                           | Last 30 days        |

**Implementation:**

The `requires_shipping` filter is applied at the **line item level**, not the order level. An order can have both shipping and pickup line items. The GraphQL query should filter:

```graphql
lineItems(first: 100) {
  nodes {
    quantity
    requiresShipping    # NEW: use this to filter
    variant {
      id
      title
      sku
      product { title }
    }
  }
}
```

Skip line items where `requiresShipping` doesn't match the filter.

---

## Printable Output

### Approach: Dedicated print page opened in new tab

The pick list generates a standalone HTML page optimised for printing:

1. User clicks "Print Pick List" button
2. App opens a new browser tab with `/app/picklist/print?data=<encoded>`
3. The page renders a print-optimised layout
4. Browser auto-triggers `window.print()` on load

**Or simpler: inline print view**

1. User clicks "Print"
2. The current page switches to a print-optimised view using `@media print` CSS
3. Hides all navigation, filters, and controls
4. Shows only the pick list table + order manifest

The simpler approach (inline print) avoids the complexity of data transfer between tabs. The existing `@media print` CSS block in the pick list page can be expanded to properly format the output.

**Print layout:**

- Header: "Pickle Pick List — {date} — {orderCount} orders"
- Pick list table with columns: QTY, SKU, DESC, LOCATION, PICKED (checkbox column)
- Page break before order manifest
- Order manifest with per-order contents
- Footer: page numbers

---

## Implementation Phases

| Phase | Task                                                           | Effort | Dependencies           |
| ----- | -------------------------------------------------------------- | ------ | ---------------------- |
| 1     | Update `picklist.server.ts` to use new `Bin` model for sorting | Medium | Bin Locations Redesign |
| 2     | Add Mode 2 (base unit resolution) to pick list service         | Medium | —                      |
| 3     | Add order manifest generation                                  | Low    | —                      |
| 4     | Update filter options (requires_shipping, fulfilled)           | Low    | —                      |
| 5     | Redesign pick list UI with mode toggle + new filters           | Medium | Phases 1-4             |
| 6     | Print-optimised output                                         | Medium | Phase 5                |
| 7     | Shopify admin action extension                                 | Medium | Phase 5                |

---

## Data Flow

```
Orders (Shopify GraphQL)
    ↓
Filter (status, shipping, date)
    ↓
Line Items
    ↓
┌──────────────────────┬───────────────────────────┐
│ Mode 1 (Standard)    │ Mode 2 (Resolved)          │
│ expandOnPick only    │ ALL bundles expanded        │
└──────────┬───────────┴────────────┬──────────────┘
           ↓                        ↓
    Aggregate by variant     Aggregate by variant
           ↓                        ↓
    Join with Bin (sortOrder + name)
           ↓
    Sort by bin sortOrder → product name
           ↓
    Pick List Table + Order Manifest
```

---

## Types (Updated)

```typescript
interface PickListItem {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  variantGid: string;
  quantity: number;
  binName: string | null; // renamed from binLocation
  binSortOrder: number; // for sorting
}

interface PickListResult {
  items: PickListItem[];
  orderCount: number;
  totalItems: number;
  generatedAt: Date;
  orders: OrderSummary[]; // NEW: for manifest
  mode: "standard" | "resolved";
}

interface OrderSummary {
  name: string; // e.g. "GPWeb130149"
  lineItems: Array<{
    quantity: number;
    description: string; // e.g. "Fat Cat - 4-Pack (FTCAT-440-4)"
  }>;
}
```
