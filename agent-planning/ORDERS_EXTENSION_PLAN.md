# Orders Page Extension Plan

## Goal

Integrate Spicy Pickle's pick list generator directly into the Shopify Admin Orders page via two Admin Action extensions, so merchants can generate pick lists without leaving the orders workflow.

---

## Extension 1: Selection Action — "Spicy Pick List" (Selected Orders)

**Target:** `admin.order-index.selection-action.render`

**Appears in:** The `...` bulk actions menu when one or more orders are selected on the Orders page.

**Label:** "Spicy Pick List"

**Behaviour:**

1. Merchant selects orders on the Orders index page (up to 50 per page, or across multiple pages).
2. Clicks `...` → "Spicy Pick List".
3. A modal opens showing how many orders are selected and a "Generate" button.
4. On confirm, the extension passes the selected order GIDs to the Pick List page via a backend handoff.
5. The Pick List page generates and displays the result for review. Merchant clicks "Print" manually.

**Data flow (primary — URL-based):**

The extension extracts numeric order IDs from the GIDs and passes them as comma-separated query params. This avoids cross-origin API calls from the sandboxed extension environment.

```
Extension (modal)
  → Extracts numeric IDs from GIDs (e.g. "gid://shopify/Order/123" → "123")
  → Navigates to /app/picklist?orders=123,456,789
  → Pick List page reconstructs GIDs and generates the pick list
```

**Data flow (fallback — session-based for API consumers):**

A `PickListSession` model + `/api/picklist` endpoint is also available for programmatic use (e.g., future integrations or very large order sets beyond URL limits):

```
POST /api/picklist { intent: "prepare", orderIds: [...] }
  → Returns { sessionId: "abc123" }
Navigate to /app/picklist?session=abc123
  → Pick List page loads session, retrieves orderIds, generates pick list
```

### Filter behaviour

All shop default settings (mode, sort, direction, status filters) apply to extension-generated pick lists. If a selected order is fulfilled but the "fulfilled" filter is off, it is **silently excluded** — the user configures their defaults once and the behaviour is predictable.

---

## Extension 2: Page-Level Action — "All Pending Spicy Pickles" (Outstanding Orders)

**Target:** `admin.order-index.action.render`

**Appears in:** The "More actions" dropdown at the top of the Orders index page.

**Label:** "All Pending Spicy Pickles"

**Behaviour:**

1. Merchant clicks "More actions" → "All Pending Spicy Pickles".
2. A modal opens with a brief confirmation ("Generate a pick list for all outstanding orders?").
3. On confirm, navigates to the Pick List page with `?auto=true`.
4. The Pick List page auto-triggers generation using saved defaults (equivalent to "Fetch Outstanding Orders" + "Generate").
5. Merchant reviews and clicks "Print" manually.

**Data flow:**

```
Extension (modal) → Navigates to /app/picklist?auto=true
                  → Pick List page auto-triggers generation on load
```

No order IDs needed — this uses the normal date range / status filter flow.

---

## Technical Architecture

### Extension scaffold

Each extension lives in `extensions/<name>/` with its own `shopify.extension.toml` and source files. Extensions use Preact (Shopify's default for admin extensions) and Polaris web components.

```
extensions/
  spicy-pick-list/
    shopify.extension.toml      # target: admin.order-index.selection-action.render
    src/
      index.jsx                 # Preact component (modal UI)
    locales/
      en.default.json
  all-pending-pickles/
    shopify.extension.toml      # target: admin.order-index.action.render
    src/
      index.jsx                 # Preact component (modal UI)
    locales/
      en.default.json
```

### New Prisma model: PickListSession

For handling >50 orders, a short-lived session record stores the order IDs:

```prisma
model PickListSession {
  id        String   @id @default(cuid())
  shopId    String
  orderIds  String   // JSON array of order GIDs
  createdAt DateTime @default(now())

  @@index([shopId])
}
```

Cleanup: sessions older than 1 hour are deleted on read or via a periodic sweep.

### Backend API endpoint

```
app/routes/api.picklist.tsx
```

Two intents:

- **`POST { intent: "prepare", orderIds: [...] }`** — Stores order IDs in `PickListSession`, returns `{ sessionId }`.
- **`GET ?session=<id>`** — Retrieves and deletes the session, returns order IDs.

Both use `authenticate.admin(request)` with CORS headers for cross-origin extension calls.

### Pick List page changes (`app.picklist._index.tsx`)

- Accept `?orders=id1,id2,...` query param → reconstruct GIDs from numeric IDs
- Accept `?session=<id>` query param → load order IDs from `PickListSession` (fallback)
- Accept `?auto=true` query param → auto-trigger generation on page load
- When order IDs are present:
  - Pass to `generatePickList()` via `PickListFilters.orderIds`
  - Display a banner: "Generating from X selected orders"
  - Bypass the date range picker
  - Auto-trigger generation via `useEffect` on first render
- Print is always manual (no auto-print)

### Extension sandbox & cross-origin considerations

Admin action extensions run in a sandboxed Preact environment on Shopify's domain — they cannot easily `fetch()` to the app's backend. The primary integration uses URL-based navigation (no API calls from extensions). The `api.picklist.tsx` route exists as infrastructure for programmatic / API-driven workflows and uses `authenticate.admin(request)` with CORS headers.

---

## Naming

| Extension        | Label in Shopify Admin      | Internal folder name  |
| ---------------- | --------------------------- | --------------------- |
| Selection action | "Spicy Pick List"           | `spicy-pick-list`     |
| Page action      | "All Pending Spicy Pickles" | `all-pending-pickles` |

---

## Branding

Both extensions use the Spicy Pickle mascot icon (green pickle character). The icon file is stored at `assets/pickle-icon.png` and referenced in each extension's `shopify.extension.toml`.

---

## Deployment

Extensions require `shopify app deploy` to register with Shopify. They can be developed locally with `shopify app dev`. After deployment, both actions will appear in the Orders page menus for all users of the app.

---

## Resolved Decisions

| #   | Question                            | Answer                                                                                   |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Extension labels                    | "Spicy Pick List" and "All Pending Spicy Pickles"                                        |
| 2   | Pre-generation vs on-page           | On-page — extensions pass order IDs, Pick List page handles generation                   |
| 3   | Status filtering on selected orders | Silently exclude based on saved defaults                                                 |
| 4   | Order limit                         | URL-based for typical selections (~50-250); PickListSession fallback for very large sets |
| 5   | Print behaviour                     | Display for review, manual print                                                         |
| 6   | Extension icon                      | Spicy Pickle mascot (green pickle character)                                             |

---

## Implementation Order

1. **Prisma migration** — Add `PickListSession` model
2. **Backend API route** — `api.picklist.tsx` with CORS-enabled auth, prepare/retrieve intents
3. **Pick List page updates** — `session` and `auto` query param support, order-ID mode banner
4. **Scaffold extensions** — `shopify app generate extension` for both targets
5. **Extension UI** — Preact modal components with confirmation + navigation
6. **Deploy and test** — `shopify app deploy`
