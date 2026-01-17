I want to make a Shopify app which will manage inventory and assist picking of an ecommerce website's fullfment process. The high level functionalities should combine the features of multiple other apps that are currently being used in production;

# Business Logic

## "Bundle" inventory sync: 
My store uses an app called Bundles.app to sync the inventory quantites of products which represent different quantities of a base product. For example, one product might have variants of "Single 330ml Can", "6-Pack", "4-Pack", "24-Pack". A 24-Pack would be assigned a value of "24" and a "Child" of "Single 330ml Can". This assignment uses GID, not SKU or Title to ensure no ambiguity.
The 4-Pack would be "4" times the "Single 330ml Can" GID and so on. We also have examples where a Product or Product Variant represent a mixed bundle of goods. In that case, we might have an example of "Product A Variant 1" assigned as the parent, with 1x each of the "Product B Variant 1", "Product C Variant 1" and "Product D Variant 1" assigned to it. In each of these cases, as inventory adjustments are made to any one of the relevant children or parents, the quantity changes are propogated out so there is a true reflection of availability for all products and product variants. In the latter example, this would mean if one of the items sells out, the parent product should become unavailable.
Relationships are configured via a GUI; user selects a parent, and then adds/removes children and their quantities.
For a product with variants of Single,4,6,24-pack which has 48 physical single units available, we would expect to see
Single: 48
4-pack: 12
6-pack: 8
24-pack: 2
If 2x 4-packs were sold in one order, this would reduce the physical stock available from 48 to 40. This would need to be reflected across the availability of all shopify variants as
Single: 40
4-pack: 10
6-pack: 6 (as it would be 6 whole, and 0.66 partial 6-packs)
24-pack: 1 (same logic as above)

## "Pick List"
My store uses an app called Pickle which uses an input list of orders, and generates a list of products which are required to fulfill all of the orders from the input list. The output list is bucketed by product variant e.g. if there are 3 orders for 1x Product A Variant 1, 10 orders for 1x Product A Variant 2, 1 order for 24x Product A Variant 1, 1 order for 4x Product A Variant 2, the Pickle app would output the list of products as per below:
- Product Variant | Quantity | Bin
- Product A Variant 1 |  27 | Location 1
- Product A Variant 2 | 14 | Location 1
The Bin locations are manually set and can consist of any string. 
There is also a function similar to the 'Bundle' functionality above, whereby a combination of the fields below can be used to replace a given Parent with its constituent Children.
- Parent Name: String
- Parent SKU: String
- Child SKUs: Array[String]
The list of Products is managed via a spreadsheet import/export. The bundle functionality of the Pick List is managed via GUI, but does not allow automation.

# Solution
The ideal solution should combine the configuration overhead of these two apps to avoid duplication.
- The configuration should be read/write accessible via Shopify API so that it can be automated. I think the easiest way for this to be done is via metafields which can be exposed to other apps.
- There should be a GUI to configure relationships between products/product variants
- There should also be .CSV import/export capabilities as an alternative to the API or GUI methods.
- The relationships should be extnedable to include other fields, such as a supplier SKU and supplier SKU costs in order to get granular costs per line item. Whenever an order is created, I want this relationship to be optionally writable to a field on the order to aid in financial reconcilliation. The atual write functionality can be implemented with least priority.

## Architecture
The inventory sync handler must be able to scale to high numbers of inventory changes in short bursts. For example, a burst in orders of 600+ may result in anywhere between 600 and 6000 inventory quantity changes, based on the number of line items per order. These would need to be queued in order to prevent errors.

I would prefer to use Google Cloud for all hosting services, so including google Pub/Sub which is natively part of the Shopify development experience as of 2026 would be helpful. 

If a database is required (either for storage, or caching), the main tables should only be as large as the number of variants, prioritising a database with high I/O.

While this app is being developed for use by my store, I intend to share it around, so the a database architecture that enables stores to have their information securely stored is necessary.