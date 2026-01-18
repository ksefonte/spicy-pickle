# Bundle Builder Refinement Plan

## Summary

Refactor the bundle configuration system to be more intuitive with a table-based UI, add automation for common bundle patterns, and implement Supplier SKU tracking for inventory cost reconciliation.

---

## Phase 1: File Reorganization

Move planning documents to a dedicated directory:

- Create `agent-planning/` directory
- Move `PRE_PLAN.MD` to `agent-planning/PRE_PLAN.md`
- Move `DEVELOPMENT_PLAN.md` to `agent-planning/DEVELOPMENT_PLAN.md`
- Create `agent-planning/BUNDLE_REFINEMENT_PLAN.md` for this plan

---

## Phase 2: Database Schema Updates

Update `prisma/schema.prisma` to add Supplier SKU tracking and remove the `name` field from Bundle:

```prisma
model Bundle {
  id           String        @id @default(cuid())
  shopId       String
  shop         Shop          @relation(fields: [shopId], references: [id], onDelete: Cascade)
  // Remove: name field (will derive from parent variant title)
  parentGid    String
  parentTitle  String?       // Cached title from Shopify (for display)
  parentSku    String?       // Cached SKU from Shopify (for display)
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  children     BundleChild[]
  expandOnPick Boolean       @default(false)

  @@unique([shopId, parentGid])
}

model SupplierSku {
  id              String   @id @default(cuid())
  shopId          String
  shop            Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  variantGid      String   // Shopify Product Variant GID
  supplierSku     String   // The supplier's SKU code (e.g., "HD 4X6")
  supplierSkuQty  Float    // How many of this variant per supplier SKU (e.g., 0.25 for 1 6-pack = 0.25 of HD 4X6)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([shopId, variantGid])
  @@index([shopId])
}
```

---

## Phase 3: Bundle List UI - Table Format

Rewrite `app/routes/app.bundles._index.tsx`:

**Current**: Card-based layout showing each bundle as a box

**New**: Table with columns:
| Parent Name | Parent SKU | Child Name | Child Qty | Actions |
|-------------|------------|------------|-----------|---------|

Implementation approach:

- Fetch bundles with children and cache parent/child titles via GraphQL
- Render as HTML table with sortable columns
- Inline edit for quantities
- Row-level delete with confirmation
- Link to bulk actions (Quick Setup, Import/Export)

---

## Phase 4: Quick Bundle Setup Feature

Create new route `app/routes/app.bundles.quick-setup.tsx`:

**Workflow**:

1. User selects a product using Shopify Resource Picker (product level, not variant)
2. User selects which variant is the "base" (e.g., Single 330ml)
3. App displays all other variants with input fields for quantity
4. User enters quantities (e.g., 4-Pack = 4, 6-Pack = 6, 24-Pack = 24)
5. On submit, create one bundle per non-base variant, each with the base variant as child

**Key changes to bundle creation**:

- Auto-derive bundle name from parent variant title (no manual name field)
- Fetch and cache `parentTitle` and `parentSku` from Shopify on creation

---

## Phase 5: Update Existing Bundle Routes

### `app/routes/app.bundles.new.tsx`

- Remove the `name` text field
- Auto-populate name from selected parent variant title
- Store `parentTitle` and `parentSku` in database

### `app/routes/app.bundles.$id.tsx`

- Remove name editing
- Display parent title as read-only heading
- Keep child management and expandOnPick toggle

---

## Phase 6: Supplier SKU Management

### New Route: `app/routes/app.supplier-skus._index.tsx`

Table-based UI for managing supplier SKUs:
| Variant Name | Variant SKU | Supplier SKU | Qty per Supplier SKU | Actions |

### New Route: `app/routes/app.supplier-skus.import.tsx`

CSV import with format:

```csv
variant_gid,supplier_sku,supplier_sku_qty
gid://shopify/ProductVariant/123,HD 4X6,0.25
gid://shopify/ProductVariant/456,HD 330ML BOX,0.0833
```

### Navigation Update

Add "Supplier SKUs" link to `app/routes/app.tsx` navigation.

---

## Phase 7: CSV Import/Export Updates

### Update `app/routes/app.bundles.import.tsx`

New simplified CSV format:

```csv
parent_gid,parent_name,parent_sku,child_gid,child_name,quantity,expand_on_pick
```

### Update `app/routes/app.bundles.export.tsx`

Match the new import format with human-readable names included.

---

## Phase 8: Tests and Documentation

- Add unit tests for quick-setup bundle creation logic
- Add tests for Supplier SKU calculations
- Update README with new features

---

## File Changes Summary

| File                                      | Change Type                                   |
| ----------------------------------------- | --------------------------------------------- |
| `prisma/schema.prisma`                    | Modify - add SupplierSku model, update Bundle |
| `app/routes/app.bundles._index.tsx`       | Rewrite - table UI                            |
| `app/routes/app.bundles.new.tsx`          | Modify - remove name field                    |
| `app/routes/app.bundles.$id.tsx`          | Modify - remove name field                    |
| `app/routes/app.bundles.quick-setup.tsx`  | Create - new feature                          |
| `app/routes/app.bundles.import.tsx`       | Modify - update CSV format                    |
| `app/routes/app.bundles.export.tsx`       | Modify - update CSV format                    |
| `app/routes/app.supplier-skus._index.tsx` | Create - new feature                          |
| `app/routes/app.supplier-skus.import.tsx` | Create - new feature                          |
| `app/routes/app.tsx`                      | Modify - add navigation                       |
| `agent-planning/*`                        | Create - move planning docs                   |
