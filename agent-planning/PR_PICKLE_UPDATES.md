# PR: Pickle Updates

**Branch:** `feature/pickle-updates`
**Base:** `main`

---

## Summary

Major feature expansion of the Spicy Pickle app covering sync configuration, bin location management, pick list enhancements, product relationship tooling, Shopify Orders page integration, and comprehensive UI/UX improvements across all routes.

---

## Changes

### Sync Configuration (`app.admin.config.tsx`)

- **Global sync toggle** to enable/disable inventory syncing across the entire shop.
- **Per-bundle sync toggle** with products grouped by parent, searchable and paginated.
- **Pick list default settings** (unfulfilled, partial, fulfilled, shipping-only, mode, sort) moved into the Configuration page as persistent shop-level defaults.
- Select/deselect all visible bundles with pagination-aware "select all" support.

### Bin Locations (`app.locations._index.tsx`)

- Complete rewrite of the bin locations UI with human-readable product/variant names resolved from Shopify.
- **Product-variant selector** (matching Shopify's native Purchase Orders UX) replacing the old variant-only picker.
- Condensed display — products with all variants in one bin show by product name only.
- **Move variants between bins** via dropdown selector.
- **Remove entire products** from a bin in one action.
- Drag-and-drop bin reordering with sortable UI.

### Pick List (`app.picklist._index.tsx`, `picklist.server.ts`)

- Pick list filters (status, shipping) now use shop-level defaults from the Configuration page.
- Replaced broken `<s-select>` web components with native HTML `<select>` elements.
- **Available inventory column** (`Avail`) displayed alongside each line item.
- **Resolved mode** expands bundles with `expandOnPick` flag to their base unit components.
- Fixed consolidation bug for products with relationships not expanding (`expandOnPick` defaulting to `false` during sync).
- Support for `orderIds` filter to generate pick lists from specific orders.
- Auto-generate on page load via `?auto=true` or `?orders=` / `?ids[]=` query params.
- Order manifest section with per-order line item breakdown.
- Print-friendly CSS for pick list output.

### Product Relationships (`app.relationships._index.tsx`)

- **Dedicated Product Relationships page** for browsing and managing `product_relationship` metaobjects across all products.
- Per-variant relationship editor with add/remove capabilities.
- **Orphaned metaobject detection** — scan for `product_relationship` entries not referenced by any variant, with UI to delete or reattach them.
- Product-variant selector for adding relationships (consistent with other pages).
- **Deduplication logic** — re-adding a relationship with the same child/quantity reuses the existing metaobject instead of creating a duplicate.
- Sync toggle per bundle directly from the relationships editor.

### Metaobject Sync (`metaobject-sync.server.ts`)

- Optimised GraphQL pagination and batched Prisma writes for faster sync.
- `syncIfStale` runs as fire-and-forget to avoid blocking page loads.
- `ensureMetaobjectSetup` runs once per server process via in-memory flag.
- Deduplication of children array during sync to prevent unique constraint violations.
- Orphan detection, deletion, and reattachment functions (`findOrphanedMetaobjects`, `deleteOrphanedMetaobjects`, `reattachOrphanToVariant`).

### Metaobject Writes (`metaobject-writes.server.ts`)

- `addSingleRelationship` now checks for existing metaobjects with the same child before creating new ones.
- New helpers: `findExistingMetaobjectForChild`, `updateMetaobjectQuantity`.

### Shopify Orders Page Integration

- **Admin link extensions** (no JavaScript, TOML-only):
  - **"Spicy Pick List"** (`admin.order-index.selection-action.link`) — select orders → navigates to the Pick List page with `ids[]` params.
  - **"All Pending Spicy Pickles"** (`admin.order-index.action.link`) — "More actions" dropdown → auto-generates resolved pick list for unfulfilled orders.
- URL overrides (`mode`, `unfulfilled`, `partial`, `fulfilled`) applied when auto-generating from extensions.
- **`PickListSession` model** and `/api/picklist` endpoint as infrastructure for programmatic/API-driven pick list generation.

### Navigation & App Structure

- Removed the "Home" tab — Pick List is now the default route via client-side redirect.
- Updated navigation order: Pick List → Product Relationships → Bin Locations → Bundles → Supplier SKUs → Migration → Configuration.
- `shouldRevalidate` on `app.tsx` to prevent unnecessary parent loader revalidation after form submissions.

### Resource Pickers

- All variant pickers across the app (`migrate`, `bundles.new`, `bundles.$id`, `relationships`, `supplier-skus`, `locations`) updated from `type: "variant"` to `type: "product"` with `filter: { variants: true }` for a consistent product-variant selection UX.

### UI Polish

- Refreshed all aside panel descriptions to match current functionality.
- Migration page triggers sync after bulk migration completes.
- Clickable status cards on the migration page filter by status.
- Product detail modal on migration page for per-variant relationship inspection.
- App renamed from "spicy-pickle" to "Spicy Pickle" in `shopify.app.toml`.
- Pickle mascot icon added as `assets/pickle-icon.png`.

---

## Database Changes

### New models

- **`PickListSession`** — short-lived session for passing order IDs from extensions to the Pick List page (1-hour TTL with cleanup).

### Modified models

- **`Shop`** — added 7 pick list default fields (`picklistUnfulfilled`, `picklistPartial`, `picklistFulfilled`, `picklistShippingOnly`, `picklistMode`, `picklistSortBy`, `picklistSortDir`).

### Migrations

- `20260331000000_picklist_defaults` — adds pick list default columns to `Shop`.
- `20260401000000_picklist_session` — creates `PickListSession` table.
- Both SQLite and PostgreSQL migration files included.

---

## New Files

| File                                      | Purpose                                                        |
| ----------------------------------------- | -------------------------------------------------------------- |
| `app/routes/api.picklist.tsx`             | CORS-enabled API for programmatic pick list session management |
| `agent-planning/ORDERS_EXTENSION_PLAN.md` | Planning document for Orders page extensions                   |
| `assets/pickle-icon.png`                  | App mascot icon for branding                                   |
| `extensions/spicy-pick-list/`             | Admin link extension (order selection → pick list)             |
| `extensions/all-pending-pickles/`         | Admin link extension (all pending orders → pick list)          |

---

## Testing Notes

- [ ] Verify pick list generates correctly from the Orders page "Spicy Pick List" selection action
- [ ] Verify "All Pending Spicy Pickles" auto-generates with resolved mode and unfulfilled-only
- [ ] Verify pick list defaults persist on the Configuration page
- [ ] Verify bin location product-variant selector and move functionality
- [ ] Verify orphan detection and cleanup on the Product Relationships page
- [ ] Verify sync runs after bulk migration
- [ ] Confirm no regressions on existing bundle/migration/supplier-SKU workflows
