/**
 * Unit tests for the pick list service.
 *
 * These tests verify the core aggregation and sorting logic.
 * GraphQL-dependent functions are tested via integration tests.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateItems,
  sortItems,
  exportToCSV,
  type PickListItem,
} from "./picklist.server";

describe("aggregateItems", () => {
  it("aggregates items with the same variant GID", () => {
    const items = [
      {
        variantGid: "gid://shopify/ProductVariant/1",
        productTitle: "Lager",
        variantTitle: "Single",
        sku: "LAGER-1",
        quantity: 5,
      },
      {
        variantGid: "gid://shopify/ProductVariant/1",
        productTitle: "Lager",
        variantTitle: "Single",
        sku: "LAGER-1",
        quantity: 3,
      },
      {
        variantGid: "gid://shopify/ProductVariant/2",
        productTitle: "Lager",
        variantTitle: "6-Pack",
        sku: "LAGER-6",
        quantity: 2,
      },
    ];

    const result = aggregateItems(items);

    expect(result).toHaveLength(2);
    expect(
      result.find((i) => i.variantGid === "gid://shopify/ProductVariant/1")
        ?.quantity,
    ).toBe(8);
    expect(
      result.find((i) => i.variantGid === "gid://shopify/ProductVariant/2")
        ?.quantity,
    ).toBe(2);
  });

  it("handles single item", () => {
    const items = [
      {
        variantGid: "gid://shopify/ProductVariant/1",
        productTitle: "Lager",
        variantTitle: "Single",
        sku: "LAGER-1",
        quantity: 10,
      },
    ];

    const result = aggregateItems(items);

    expect(result).toHaveLength(1);
    expect(result[0]?.quantity).toBe(10);
  });

  it("handles empty array", () => {
    const result = aggregateItems([]);
    expect(result).toHaveLength(0);
  });

  it("preserves product info from first occurrence", () => {
    const items = [
      {
        variantGid: "gid://shopify/ProductVariant/1",
        productTitle: "First Title",
        variantTitle: "First Variant",
        sku: "FIRST-SKU",
        quantity: 5,
      },
      {
        variantGid: "gid://shopify/ProductVariant/1",
        productTitle: "Second Title",
        variantTitle: "Second Variant",
        sku: "SECOND-SKU",
        quantity: 3,
      },
    ];

    const result = aggregateItems(items);

    expect(result).toHaveLength(1);
    expect(result[0]?.productTitle).toBe("First Title");
    expect(result[0]?.variantTitle).toBe("First Variant");
    expect(result[0]?.sku).toBe("FIRST-SKU");
    expect(result[0]?.quantity).toBe(8);
  });
});

describe("sortItems", () => {
  const testItems: PickListItem[] = [
    {
      productTitle: "Lager",
      variantTitle: "Single",
      sku: "LAGER-1",
      variantGid: "gid://1",
      quantity: 10,
      binName: "B-02",
      binSortOrder: 2,
      available: 50,
    },
    {
      productTitle: "Ale",
      variantTitle: "6-Pack",
      sku: "ALE-6",
      variantGid: "gid://2",
      quantity: 5,
      binName: "A-01",
      binSortOrder: 0,
      available: 30,
    },
    {
      productTitle: "Stout",
      variantTitle: "Single",
      sku: "STOUT-1",
      variantGid: "gid://3",
      quantity: 20,
      binName: null,
      binSortOrder: Number.MAX_SAFE_INTEGER,
      available: null,
    },
    {
      productTitle: "Ale",
      variantTitle: "Single",
      sku: "ALE-1",
      variantGid: "gid://4",
      quantity: 3,
      binName: "A-02",
      binSortOrder: 1,
      available: 15,
    },
  ];

  describe("sort by bin", () => {
    it("sorts by bin sortOrder ascending", () => {
      const result = sortItems(testItems, "bin", "asc");

      expect(result[0]?.binName).toBe("A-01");
      expect(result[1]?.binName).toBe("A-02");
      expect(result[2]?.binName).toBe("B-02");
      expect(result[3]?.binName).toBeNull();
    });

    it("sorts by bin sortOrder descending", () => {
      const result = sortItems(testItems, "bin", "desc");

      expect(result[0]?.binName).toBe("B-02");
      expect(result[1]?.binName).toBe("A-02");
      expect(result[2]?.binName).toBe("A-01");
      expect(result[3]?.binName).toBeNull();
    });
  });

  describe("sort by product", () => {
    it("sorts by product title then variant title ascending", () => {
      const result = sortItems(testItems, "product", "asc");

      expect(result[0]?.productTitle).toBe("Ale");
      expect(result[0]?.variantTitle).toBe("6-Pack");
      expect(result[1]?.productTitle).toBe("Ale");
      expect(result[1]?.variantTitle).toBe("Single");
      expect(result[2]?.productTitle).toBe("Lager");
      expect(result[3]?.productTitle).toBe("Stout");
    });

    it("sorts by product title descending", () => {
      const result = sortItems(testItems, "product", "desc");

      expect(result[0]?.productTitle).toBe("Stout");
      expect(result[1]?.productTitle).toBe("Lager");
      expect(result[2]?.productTitle).toBe("Ale");
    });
  });

  describe("sort by quantity", () => {
    it("sorts by quantity ascending", () => {
      const result = sortItems(testItems, "quantity", "asc");

      expect(result[0]?.quantity).toBe(3);
      expect(result[1]?.quantity).toBe(5);
      expect(result[2]?.quantity).toBe(10);
      expect(result[3]?.quantity).toBe(20);
    });

    it("sorts by quantity descending", () => {
      const result = sortItems(testItems, "quantity", "desc");

      expect(result[0]?.quantity).toBe(20);
      expect(result[1]?.quantity).toBe(10);
      expect(result[2]?.quantity).toBe(5);
      expect(result[3]?.quantity).toBe(3);
    });
  });
});

describe("exportToCSV", () => {
  it("exports items to CSV format", () => {
    const items: PickListItem[] = [
      {
        productTitle: "Lager",
        variantTitle: "Single",
        sku: "LAGER-1",
        variantGid: "gid://1",
        quantity: 10,
        binName: "A-01",
        binSortOrder: 0,
        available: 50,
      },
      {
        productTitle: "Ale",
        variantTitle: "6-Pack",
        sku: "ALE-6",
        variantGid: "gid://2",
        quantity: 5,
        binName: "B-02",
        binSortOrder: 1,
        available: 30,
      },
    ];

    const csv = exportToCSV(items);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Product,Variant,SKU,Available,Quantity,Bin");
    expect(lines[1]).toBe("Lager,Single,LAGER-1,50,10,A-01");
    expect(lines[2]).toBe("Ale,6-Pack,ALE-6,30,5,B-02");
  });

  it("escapes values with commas", () => {
    const items: PickListItem[] = [
      {
        productTitle: "Lager, Premium",
        variantTitle: "Single",
        sku: "LAGER-1",
        variantGid: "gid://1",
        quantity: 10,
        binName: "A-01",
        binSortOrder: 0,
        available: 50,
      },
    ];

    const csv = exportToCSV(items);
    const lines = csv.split("\n");

    expect(lines[1]).toContain('"Lager, Premium"');
  });

  it("escapes values with quotes", () => {
    const items: PickListItem[] = [
      {
        productTitle: 'Lager "Special"',
        variantTitle: "Single",
        sku: "LAGER-1",
        variantGid: "gid://1",
        quantity: 10,
        binName: "A-01",
        binSortOrder: 0,
        available: 50,
      },
    ];

    const csv = exportToCSV(items);
    const lines = csv.split("\n");

    expect(lines[1]).toContain('"Lager ""Special"""');
  });

  it("handles null SKU, bin, and available", () => {
    const items: PickListItem[] = [
      {
        productTitle: "Lager",
        variantTitle: "Single",
        sku: null,
        variantGid: "gid://1",
        quantity: 10,
        binName: null,
        binSortOrder: Number.MAX_SAFE_INTEGER,
        available: null,
      },
    ];

    const csv = exportToCSV(items);
    const lines = csv.split("\n");

    expect(lines[1]).toBe("Lager,Single,,,10,");
  });

  it("handles empty array", () => {
    const csv = exportToCSV([]);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Product,Variant,SKU,Available,Quantity,Bin");
  });
});

describe("pick list scenarios", () => {
  it("simulates bundle expansion for a 24-pack", () => {
    // Scenario: Customer orders 2x 24-packs, which should expand to 48 singles
    const bundleChild = {
      variantGid: "gid://shopify/ProductVariant/single",
      productTitle: "Lager",
      variantTitle: "Single",
      sku: "LAGER-1",
      quantity: 48, // 2 × 24
    };

    const result = aggregateItems([bundleChild]);

    expect(result[0]?.quantity).toBe(48);
  });

  it("simulates mixed orders aggregation", () => {
    // Scenario: Multiple orders with overlapping products
    const order1Items = [
      {
        variantGid: "gid://1",
        productTitle: "Lager",
        variantTitle: "Single",
        sku: "LAGER-1",
        quantity: 10,
      },
      {
        variantGid: "gid://2",
        productTitle: "Ale",
        variantTitle: "Single",
        sku: "ALE-1",
        quantity: 5,
      },
    ];

    const order2Items = [
      {
        variantGid: "gid://1",
        productTitle: "Lager",
        variantTitle: "Single",
        sku: "LAGER-1",
        quantity: 15,
      },
      {
        variantGid: "gid://3",
        productTitle: "Stout",
        variantTitle: "Single",
        sku: "STOUT-1",
        quantity: 8,
      },
    ];

    const order3Items = [
      {
        variantGid: "gid://2",
        productTitle: "Ale",
        variantTitle: "Single",
        sku: "ALE-1",
        quantity: 3,
      },
    ];

    const allItems = [...order1Items, ...order2Items, ...order3Items];
    const result = aggregateItems(allItems);

    // Should have 3 unique variants
    expect(result).toHaveLength(3);

    // Check aggregated quantities
    expect(result.find((i) => i.variantGid === "gid://1")?.quantity).toBe(25); // 10 + 15
    expect(result.find((i) => i.variantGid === "gid://2")?.quantity).toBe(8); // 5 + 3
    expect(result.find((i) => i.variantGid === "gid://3")?.quantity).toBe(8);
  });
});
