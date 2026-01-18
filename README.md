# Spicy Pickle 🥒

A Shopify app for **bundle inventory synchronization** and **pick list generation**. Built for breweries, beverage distributors, and any merchant selling products in multiple pack sizes.

## Features

### Bundle Inventory Sync

Automatically synchronize inventory across product variants that share a common base unit:

- **Same-product bundles**: Link Single, 4-Pack, 6-Pack, and 24-Pack variants
- **Mixed bundles**: Create variety packs with multiple different products
- **Automatic calculation**: When 48 singles are in stock, the app shows:
  - Single: 48 available
  - 4-Pack: 12 available
  - 6-Pack: 8 available
  - 24-Pack: 2 available
- **Real-time sync**: Inventory webhooks trigger instant recalculation

### Pick List Generator

Generate consolidated picking lists from unfulfilled orders:

- **Order aggregation**: Combine line items across multiple orders
- **Bundle expansion**: Optionally expand bundles to their base components
- **Bin location sorting**: Sort by warehouse location for efficient picking
- **Export options**: Print-friendly view and CSV download

### Metafield Integration

Bundle configuration and bin locations are synced to Shopify product metafields, enabling:

- External system access via Shopify API
- Third-party automation and integrations
- ERP/WMS synchronization

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started)
- [Google Cloud SDK](https://cloud.google.com/sdk) (for deployment)

### Local Development

```bash
# Install dependencies
npm install

# Start development server
shopify app dev
```

Press **P** to open your app in the browser. The app will connect to your development store.

### Available Scripts

| Script                  | Purpose                      |
| ----------------------- | ---------------------------- |
| `npm run dev`           | Start development server     |
| `npm run build`         | Build for production         |
| `npm run typecheck`     | TypeScript type checking     |
| `npm run lint`          | ESLint with type-aware rules |
| `npm run test`          | Run unit tests               |
| `npm run test:watch`    | Watch mode for TDD           |
| `npm run test:coverage` | Generate coverage report     |

---

## App Navigation

| Page          | Route            | Description                        |
| ------------- | ---------------- | ---------------------------------- |
| Home          | `/app`           | Dashboard and overview             |
| Bundles       | `/app/bundles`   | Manage bundle configurations       |
| Bin Locations | `/app/locations` | Configure warehouse bin locations  |
| Pick List     | `/app/picklist`  | Generate picking lists from orders |

---

## Bundle Configuration

### Creating a Bundle

1. Navigate to **Bundles** → **Create Bundle**
2. Select the **Parent Variant** (the bundle SKU, e.g., "Lager 24-Pack")
3. Add **Child Variants** with quantities (e.g., "Lager Single" × 24)
4. Toggle **Expand on pick** if the bundle should show components in pick lists

### Same-Product Bundles

For products sold in multiple pack sizes (Single, 4-Pack, 24-Pack):

```
Parent: Lager - 24 Pack
Child:  Lager - Single × 24

Result: 48 singles in stock → 2 × 24-packs available
```

### Mixed Bundles (Variety Packs)

For bundles containing different products:

```
Parent: Summer Sampler 12-Pack
Children:
  - Lager - Single × 4
  - Ale - Single × 4
  - Pilsner - Single × 4

Result: Availability = min(lager/4, ale/4, pilsner/4)
```

### CSV Import/Export

Bulk manage bundles via CSV files:

**Format**: `parent_gid,child_gid,quantity,expand_on_pick`

```csv
gid://shopify/ProductVariant/123,gid://shopify/ProductVariant/456,24,false
gid://shopify/ProductVariant/123,gid://shopify/ProductVariant/789,12,false
```

---

## Bin Locations

### Setup

1. Navigate to **Bin Locations** → **Import CSV**
2. Upload a CSV with variant GIDs and locations

**Format**: `variant_gid,variant_sku,bin_location`

```csv
gid://shopify/ProductVariant/123,LAGER-SINGLE,A-01-03
gid://shopify/ProductVariant/456,LAGER-24PACK,B-02-01
```

### In Pick Lists

When generating a pick list, items are sorted by bin location for efficient warehouse navigation.

---

## REST API

External systems can access bundle configuration via REST API:

### List Bundles

```http
GET /api/bundles
```

### Create Bundle

```http
POST /api/bundles
Content-Type: application/json

{
  "name": "Lager 24-Pack",
  "parentGid": "gid://shopify/ProductVariant/456",
  "expandOnPick": false,
  "children": [
    { "childGid": "gid://shopify/ProductVariant/123", "quantity": 24 }
  ]
}
```

### Update Bundle

```http
PUT /api/bundles/:id
Content-Type: application/json

{
  "name": "Updated Name",
  "expandOnPick": true
}
```

### Delete Bundle

```http
DELETE /api/bundles/:id
```

---

## Metafields

Bundle config and bin locations are stored in Shopify product variant metafields:

| Namespace      | Key             | Type             | Description                    |
| -------------- | --------------- | ---------------- | ------------------------------ |
| `spicy_pickle` | `bundle_config` | JSON             | Bundle children and quantities |
| `spicy_pickle` | `bin_location`  | Single-line text | Warehouse bin location         |

### Bundle Config Structure

```json
{
  "bundleId": "cuid123",
  "bundleName": "Lager 24-Pack",
  "expandOnPick": false,
  "children": [
    { "variantGid": "gid://shopify/ProductVariant/123", "quantity": 24 }
  ]
}
```

---

## Deployment

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Google Cloud Project: spicy-pickle-484622                       │
│ Region: australia-southeast1 (Sydney)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐     ┌─────────────────┐                   │
│  │   Cloud Run     │────▶│  GCE e2-micro   │                   │
│  │  (Spicy Pickle) │     │   (Postgres)    │                   │
│  └─────────────────┘     └────────┬────────┘                   │
│          │                        │                             │
│          │                        ▼                             │
│          │               ┌─────────────────┐                   │
│          │               │  Cloud Storage  │                   │
│          │               │   (Backups)     │                   │
│          │               └─────────────────┘                   │
│          ▼                                                      │
│  ┌─────────────────┐                                           │
│  │  Cloud Pub/Sub  │                                           │
│  │  (Webhooks)     │                                           │
│  └─────────────────┘                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Infrastructure Components

| Component     | Service                   | Cost                      |
| ------------- | ------------------------- | ------------------------- |
| App hosting   | Cloud Run                 | ~$0-5/mo (scales to zero) |
| Database      | GCE e2-micro + PostgreSQL | ~$1.70/mo (10GB SSD)      |
| Webhook queue | Cloud Pub/Sub             | ~$0-1/mo                  |
| Backups       | Cloud Storage             | ~$0.05/mo                 |
| **Total**     |                           | **~$2-8/month**           |

### Database Setup

See [infrastructure/README.md](infrastructure/README.md) for detailed GCE Postgres setup instructions.

**Local Development**: Uses SQLite (`prisma/dev.sqlite`)  
**Production**: PostgreSQL on GCE e2-micro

### Environment Variables

```env
# Shopify (auto-configured by Shopify CLI)
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SHOPIFY_APP_URL=https://your-app.run.app
SCOPES=read_products,write_products,read_inventory,write_inventory,read_orders

# Database (production)
DATABASE_URL=postgresql://user:password@internal-ip:5432/spicypickle

# Optional
NODE_ENV=production
```

### Deployment Steps

1. **Build the app**:

   ```bash
   npm run build
   ```

2. **Deploy to Cloud Run**:

   ```bash
   gcloud run deploy spicy-pickle \
     --source . \
     --region australia-southeast1 \
     --allow-unauthenticated \
     --vpc-connector spicy-pickle-connector \
     --set-env-vars DATABASE_URL=$DATABASE_URL
   ```

3. **Update Shopify app URL**:
   ```bash
   shopify app deploy
   ```

### Webhook Configuration

Webhooks are configured in `shopify.app.toml`:

```toml
[webhooks]
  api_version = "2025-04"

  [[webhooks.subscriptions]]
    topics = ["inventory_levels/update"]
    uri = "/webhooks/inventory"
```

For high-volume stores (600+ inventory changes), use Cloud Pub/Sub. See [infrastructure/README.md](infrastructure/README.md) for setup.

---

## Development

### Tech Stack

| Layer    | Technology                                      |
| -------- | ----------------------------------------------- |
| Frontend | React Router v7, Shopify Polaris Web Components |
| Backend  | React Router server routes, Prisma ORM          |
| Database | PostgreSQL 16 (prod) / SQLite (dev)             |
| Queue    | Google Cloud Pub/Sub                            |
| Hosting  | Google Cloud Run                                |
| API      | Shopify Admin GraphQL API (2025-04)             |

### Project Structure

```
app/
├── routes/
│   ├── app._index.tsx          # Dashboard
│   ├── app.bundles._index.tsx  # Bundle list
│   ├── app.bundles.new.tsx     # Create bundle
│   ├── app.bundles.$id.tsx     # Edit bundle
│   ├── app.locations._index.tsx # Bin locations
│   ├── app.picklist._index.tsx # Pick list generator
│   ├── api.bundles.tsx         # REST API (list/create)
│   ├── api.bundles.$id.tsx     # REST API (get/update/delete)
│   └── webhooks.inventory.tsx  # Inventory webhook handler
├── services/
│   ├── inventory-sync.server.ts      # Inventory sync logic
│   ├── inventory-sync.server.test.ts # Unit tests
│   ├── picklist.server.ts            # Pick list generation
│   ├── picklist.server.test.ts       # Unit tests
│   └── metafields.server.ts          # Metafield sync
├── shopify.server.ts           # Shopify app configuration
└── db.server.ts                # Prisma client
infrastructure/
├── docker-compose.yml          # Postgres container
├── backup.sh                   # Database backup script
└── README.md                   # Infrastructure setup guide
prisma/
└── schema.prisma               # Database schema
```

### Quality Gates

| Hook       | Scripts                             | Purpose             |
| ---------- | ----------------------------------- | ------------------- |
| Pre-commit | `eslint --fix`, `prettier --write`  | Auto-fix and format |
| Pre-push   | `npm run typecheck`, `npm run test` | Full validation     |

### Running Tests

```bash
# Run all tests
npm run test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

---

## Troubleshooting

### Database tables don't exist

Run the Prisma migration:

```bash
npx prisma migrate deploy
```

### Webhook not triggering

1. Ensure scopes include `read_inventory`, `write_inventory`
2. Run `shopify app deploy` to sync webhook subscriptions
3. Check Cloud Run logs for errors

### Inventory sync loop

The app uses `SyncLock` to prevent infinite loops. If stuck, clear expired locks:

```sql
DELETE FROM "SyncLock" WHERE "expiresAt" < NOW();
```

---

## Resources

- [Shopify App Development](https://shopify.dev/docs/apps/getting-started)
- [Shopify Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql)
- [React Router Documentation](https://reactrouter.com/home)
- [Prisma Documentation](https://www.prisma.io/docs)
- [Google Cloud Run](https://cloud.google.com/run/docs)

---

## License

Private - Garage Project
