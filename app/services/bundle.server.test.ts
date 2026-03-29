/**
 * Unit tests for bundle utility functions.
 *
 * Tests cover:
 * - Quick-setup bundle generation logic
 * - Title-based quantity detection
 * - Supplier SKU calculations
 */

import { describe, it, expect } from "vitest";
import {
  detectQuantityFromTitle,
  generateQuickSetupBundles,
  calculateSupplierSkuRatio,
  calculateSupplierSkuNeeded,
  aggregateSupplierSkuConsumption,
} from "./bundle.server";

describe("detectQuantityFromTitle", () => {
  describe("pack patterns", () => {
    it("detects '24 Pack'", () => {
      expect(detectQuantityFromTitle("24 Pack")).toBe(24);
    });

    it("detects '24-Pack'", () => {
      expect(detectQuantityFromTitle("24-Pack")).toBe(24);
    });

    it("detects '24pack'", () => {
      expect(detectQuantityFromTitle("24pack")).toBe(24);
    });

    it("detects '6 Pack'", () => {
      expect(detectQuantityFromTitle("6 Pack")).toBe(6);
    });

    it("detects '4-pack'", () => {
      expect(detectQuantityFromTitle("4-pack")).toBe(4);
    });
  });

  describe("pk patterns", () => {
    it("detects '24pk'", () => {
      expect(detectQuantityFromTitle("24pk")).toBe(24);
    });

    it("detects '6 pk'", () => {
      expect(detectQuantityFromTitle("6 pk")).toBe(6);
    });

    it("detects '12-pk'", () => {
      expect(detectQuantityFromTitle("12-pk")).toBe(12);
    });
  });

  describe("x patterns", () => {
    it("detects '6x330ml'", () => {
      expect(detectQuantityFromTitle("6x330ml")).toBe(6);
    });

    it("detects '6 x 330ml'", () => {
      expect(detectQuantityFromTitle("6 x 330ml")).toBe(6);
    });

    it("detects '4x500ml'", () => {
      expect(detectQuantityFromTitle("4x500ml")).toBe(4);
    });
  });

  describe("case/box patterns", () => {
    it("detects 'Case of 24'", () => {
      expect(detectQuantityFromTitle("Case of 24")).toBe(24);
    });

    it("detects 'Box of 12'", () => {
      expect(detectQuantityFromTitle("Box of 12")).toBe(12);
    });

    it("detects 'pack of 6'", () => {
      expect(detectQuantityFromTitle("pack of 6")).toBe(6);
    });
  });

  describe("single patterns", () => {
    it("detects 'Single'", () => {
      expect(detectQuantityFromTitle("Single")).toBe(1);
    });

    it("detects 'single'", () => {
      expect(detectQuantityFromTitle("single")).toBe(1);
    });

    it("detects 'Single 330ml'", () => {
      expect(detectQuantityFromTitle("Single 330ml")).toBe(1);
    });

    it("detects 'Individual'", () => {
      expect(detectQuantityFromTitle("Individual")).toBe(1);
    });
  });

  describe("just number patterns", () => {
    it("detects '24' alone", () => {
      expect(detectQuantityFromTitle("24")).toBe(24);
    });

    it("detects '6' alone", () => {
      expect(detectQuantityFromTitle("6")).toBe(6);
    });
  });

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      expect(detectQuantityFromTitle("")).toBeNull();
    });

    it("returns null for non-matching patterns", () => {
      expect(detectQuantityFromTitle("Large")).toBeNull();
    });

    it("returns null for text without numbers", () => {
      expect(detectQuantityFromTitle("Default Title")).toBeNull();
    });

    it("handles mixed case", () => {
      expect(detectQuantityFromTitle("24 PACK")).toBe(24);
    });
  });
});

describe("generateQuickSetupBundles", () => {
  const sampleVariants = [
    { gid: "gid://shopify/ProductVariant/1", title: "Single", sku: "BEER-1" },
    { gid: "gid://shopify/ProductVariant/2", title: "4 Pack", sku: "BEER-4" },
    { gid: "gid://shopify/ProductVariant/3", title: "6 Pack", sku: "BEER-6" },
    { gid: "gid://shopify/ProductVariant/4", title: "24 Pack", sku: "BEER-24" },
  ];

  it("generates bundles for all non-base variants with quantities", () => {
    const bundles = generateQuickSetupBundles(
      sampleVariants,
      "gid://shopify/ProductVariant/1", // Single as base
      {
        "gid://shopify/ProductVariant/2": 4,
        "gid://shopify/ProductVariant/3": 6,
        "gid://shopify/ProductVariant/4": 24,
      },
    );

    expect(bundles).toHaveLength(3);
    expect(bundles[0]).toEqual({
      parentGid: "gid://shopify/ProductVariant/2",
      parentTitle: "4 Pack",
      parentSku: "BEER-4",
      baseVariantGid: "gid://shopify/ProductVariant/1",
      quantity: 4,
    });
  });

  it("skips base variant", () => {
    const bundles = generateQuickSetupBundles(
      sampleVariants,
      "gid://shopify/ProductVariant/1",
      {
        "gid://shopify/ProductVariant/1": 1, // Should be skipped
        "gid://shopify/ProductVariant/2": 4,
      },
    );

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.parentGid).toBe("gid://shopify/ProductVariant/2");
  });

  it("skips variants with quantity < 1", () => {
    const bundles = generateQuickSetupBundles(
      sampleVariants,
      "gid://shopify/ProductVariant/1",
      {
        "gid://shopify/ProductVariant/2": 0,
        "gid://shopify/ProductVariant/3": 6,
      },
    );

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.parentGid).toBe("gid://shopify/ProductVariant/3");
  });

  it("skips variants not in quantities map", () => {
    const bundles = generateQuickSetupBundles(
      sampleVariants,
      "gid://shopify/ProductVariant/1",
      {
        "gid://shopify/ProductVariant/2": 4,
        // 3 and 4 not included
      },
    );

    expect(bundles).toHaveLength(1);
  });

  it("returns empty array when all variants are base or have no quantity", () => {
    const bundles = generateQuickSetupBundles(
      sampleVariants,
      "gid://shopify/ProductVariant/1",
      {},
    );

    expect(bundles).toHaveLength(0);
  });
});

describe("calculateSupplierSkuRatio", () => {
  it("calculates ratio for 6-pack to 24-unit case", () => {
    // 6 units / 24 units per supplier SKU = 0.25
    expect(calculateSupplierSkuRatio(6, 24)).toBe(0.25);
  });

  it("calculates ratio for single to 24-unit case", () => {
    // 1 unit / 24 units per supplier SKU ≈ 0.0417
    expect(calculateSupplierSkuRatio(1, 24)).toBeCloseTo(0.0417, 3);
  });

  it("calculates ratio for 24-pack to 24-unit case (1:1)", () => {
    expect(calculateSupplierSkuRatio(24, 24)).toBe(1);
  });

  it("throws for zero supplier SKU units", () => {
    expect(() => calculateSupplierSkuRatio(6, 0)).toThrow(
      "Supplier SKU units must be a positive number",
    );
  });

  it("throws for negative supplier SKU units", () => {
    expect(() => calculateSupplierSkuRatio(6, -24)).toThrow(
      "Supplier SKU units must be a positive number",
    );
  });

  it("throws for zero Shopify variant units", () => {
    expect(() => calculateSupplierSkuRatio(0, 24)).toThrow(
      "Shopify variant units must be a positive number",
    );
  });
});

describe("calculateSupplierSkuNeeded", () => {
  it("calculates supplier SKUs needed for order of 4 six-packs", () => {
    // 4 six-packs at 0.25 each = 1 supplier SKU
    expect(calculateSupplierSkuNeeded(4, 0.25)).toBe(1);
  });

  it("rounds up partial supplier SKUs", () => {
    // 5 six-packs at 0.25 each = 1.25, rounds to 2
    expect(calculateSupplierSkuNeeded(5, 0.25)).toBe(2);
  });

  it("handles exact multiples", () => {
    // 8 six-packs at 0.25 each = 2 supplier SKUs
    expect(calculateSupplierSkuNeeded(8, 0.25)).toBe(2);
  });

  it("handles single units", () => {
    // 10 singles at 0.0417 each ≈ 0.417, rounds to 1
    expect(calculateSupplierSkuNeeded(10, 0.0417)).toBe(1);
  });

  it("throws for zero supplier SKU quantity", () => {
    expect(() => calculateSupplierSkuNeeded(10, 0)).toThrow(
      "Supplier SKU quantity must be a positive number",
    );
  });
});

describe("aggregateSupplierSkuConsumption", () => {
  const supplierSkuMap = new Map([
    [
      "gid://shopify/ProductVariant/1",
      { supplierSku: "CASE-24", supplierSkuQty: 0.0417 }, // Single
    ],
    [
      "gid://shopify/ProductVariant/2",
      { supplierSku: "CASE-24", supplierSkuQty: 0.25 }, // 6-pack
    ],
    [
      "gid://shopify/ProductVariant/3",
      { supplierSku: "CASE-24", supplierSkuQty: 1 }, // 24-pack
    ],
  ]);

  it("aggregates consumption for multiple orders of same variant", () => {
    const orders = [
      { variantGid: "gid://shopify/ProductVariant/2", quantity: 4 },
      { variantGid: "gid://shopify/ProductVariant/2", quantity: 4 },
    ];

    const consumption = aggregateSupplierSkuConsumption(orders, supplierSkuMap);

    expect(consumption.get("CASE-24")).toBe(2); // 8 * 0.25 = 2
  });

  it("aggregates consumption across different variants with same supplier SKU", () => {
    const orders = [
      { variantGid: "gid://shopify/ProductVariant/2", quantity: 4 }, // 4 * 0.25 = 1
      { variantGid: "gid://shopify/ProductVariant/3", quantity: 2 }, // 2 * 1 = 2
    ];

    const consumption = aggregateSupplierSkuConsumption(orders, supplierSkuMap);

    expect(consumption.get("CASE-24")).toBe(3); // 1 + 2 = 3
  });

  it("ignores orders for unmapped variants", () => {
    const orders = [
      { variantGid: "gid://shopify/ProductVariant/999", quantity: 10 },
    ];

    const consumption = aggregateSupplierSkuConsumption(orders, supplierSkuMap);

    expect(consumption.size).toBe(0);
  });

  it("handles empty orders array", () => {
    const consumption = aggregateSupplierSkuConsumption([], supplierSkuMap);

    expect(consumption.size).toBe(0);
  });

  it("handles different supplier SKUs", () => {
    const multiSkuMap = new Map([
      [
        "gid://shopify/ProductVariant/1",
        { supplierSku: "LAGER-CASE", supplierSkuQty: 0.25 },
      ],
      [
        "gid://shopify/ProductVariant/2",
        { supplierSku: "PALE-CASE", supplierSkuQty: 0.25 },
      ],
    ]);

    const orders = [
      { variantGid: "gid://shopify/ProductVariant/1", quantity: 4 },
      { variantGid: "gid://shopify/ProductVariant/2", quantity: 8 },
    ];

    const consumption = aggregateSupplierSkuConsumption(orders, multiSkuMap);

    expect(consumption.get("LAGER-CASE")).toBe(1);
    expect(consumption.get("PALE-CASE")).toBe(2);
  });
});
