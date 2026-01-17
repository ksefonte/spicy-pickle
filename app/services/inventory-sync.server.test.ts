/**
 * Unit tests for the inventory sync service.
 *
 * These tests verify the core calculation logic for bundle inventory sync.
 * The GraphQL-dependent functions are tested via integration tests.
 */

import { describe, it, expect } from "vitest";
import {
  calculateBundleAvailability,
  calculateMixedBundleAvailability,
} from "./inventory-sync.server";

describe("calculateBundleAvailability", () => {
  describe("basic calculations", () => {
    it("calculates availability for a 24-pack with 48 physical units", () => {
      expect(calculateBundleAvailability(48, 24)).toBe(2);
    });

    it("calculates availability for a 6-pack with 48 physical units", () => {
      expect(calculateBundleAvailability(48, 6)).toBe(8);
    });

    it("calculates availability for a 4-pack with 48 physical units", () => {
      expect(calculateBundleAvailability(48, 4)).toBe(12);
    });

    it("calculates availability for singles (1:1 ratio)", () => {
      expect(calculateBundleAvailability(48, 1)).toBe(48);
    });
  });

  describe("after purchase scenarios", () => {
    // User's example: 2x 4-packs sold reduces physical stock from 48 to 40
    it("recalculates after selling 2x 4-packs (40 units remaining)", () => {
      expect(calculateBundleAvailability(40, 1)).toBe(40); // Singles
      expect(calculateBundleAvailability(40, 4)).toBe(10); // 4-packs
      expect(calculateBundleAvailability(40, 6)).toBe(6); // 6-packs (6.66 rounded down)
      expect(calculateBundleAvailability(40, 24)).toBe(1); // 24-packs (1.66 rounded down)
    });

    it("handles partial packs correctly (7 units, 6-pack)", () => {
      expect(calculateBundleAvailability(7, 6)).toBe(1);
    });

    it("handles zero stock", () => {
      expect(calculateBundleAvailability(0, 24)).toBe(0);
    });

    it("handles stock less than multiplier", () => {
      expect(calculateBundleAvailability(5, 6)).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles large quantities", () => {
      expect(calculateBundleAvailability(10000, 24)).toBe(416);
    });

    it("throws error for zero multiplier", () => {
      expect(() => calculateBundleAvailability(48, 0)).toThrow(
        "Multiplier must be a positive number",
      );
    });

    it("throws error for negative multiplier", () => {
      expect(() => calculateBundleAvailability(48, -1)).toThrow(
        "Multiplier must be a positive number",
      );
    });
  });
});

describe("calculateMixedBundleAvailability", () => {
  describe("basic variety pack calculations", () => {
    it("calculates availability when all components have equal relative stock", () => {
      // Variety pack: 2x Beer A, 2x Beer B, 2x Beer C
      // Stock: 10 of each = 5 packs available
      const components = [
        { stock: 10, quantity: 2 },
        { stock: 10, quantity: 2 },
        { stock: 10, quantity: 2 },
      ];
      expect(calculateMixedBundleAvailability(components)).toBe(5);
    });

    it("returns minimum when one component is limiting", () => {
      // Variety pack: 2x Beer A, 2x Beer B, 2x Beer C
      // Stock: 10 of A and B, but only 4 of C = 2 packs available
      const components = [
        { stock: 10, quantity: 2 },
        { stock: 10, quantity: 2 },
        { stock: 4, quantity: 2 },
      ];
      expect(calculateMixedBundleAvailability(components)).toBe(2);
    });

    it("handles different quantities per component", () => {
      // Variety pack: 1x Premium Beer, 3x Regular Beer
      // Stock: 5 premium, 12 regular
      // Premium limits to 5, Regular limits to 4, so 4 packs available
      const components = [
        { stock: 5, quantity: 1 },
        { stock: 12, quantity: 3 },
      ];
      expect(calculateMixedBundleAvailability(components)).toBe(4);
    });
  });

  describe("real-world scenarios", () => {
    it("handles a 12-variety sampler pack", () => {
      // 12 different beers, 1 of each per pack
      // Various stock levels
      const components = [
        { stock: 100, quantity: 1 },
        { stock: 50, quantity: 1 },
        { stock: 30, quantity: 1 },
        { stock: 25, quantity: 1 },
        { stock: 80, quantity: 1 },
        { stock: 15, quantity: 1 }, // This one limits availability
        { stock: 45, quantity: 1 },
        { stock: 60, quantity: 1 },
        { stock: 35, quantity: 1 },
        { stock: 20, quantity: 1 },
        { stock: 55, quantity: 1 },
        { stock: 40, quantity: 1 },
      ];
      expect(calculateMixedBundleAvailability(components)).toBe(15);
    });

    it("handles a custom gift pack with uneven quantities", () => {
      // Gift pack: 6x Flagship Beer, 4x Seasonal, 2x Limited Edition
      // Stock: 120 flagship, 40 seasonal, 10 limited
      const components = [
        { stock: 120, quantity: 6 }, // 20 packs possible
        { stock: 40, quantity: 4 }, // 10 packs possible
        { stock: 10, quantity: 2 }, // 5 packs possible - limiting factor
      ];
      expect(calculateMixedBundleAvailability(components)).toBe(5);
    });
  });

  describe("edge cases", () => {
    it("returns 0 for empty components array", () => {
      expect(calculateMixedBundleAvailability([])).toBe(0);
    });

    it("returns 0 when any component has zero stock", () => {
      const components = [
        { stock: 10, quantity: 1 },
        { stock: 0, quantity: 1 },
        { stock: 10, quantity: 1 },
      ];
      expect(calculateMixedBundleAvailability(components)).toBe(0);
    });

    it("handles single component (behaves like same-product bundle)", () => {
      const components = [{ stock: 48, quantity: 24 }];
      expect(calculateMixedBundleAvailability(components)).toBe(2);
    });

    it("throws error for zero quantity", () => {
      const components = [
        { stock: 10, quantity: 1 },
        { stock: 10, quantity: 0 },
      ];
      expect(() => calculateMixedBundleAvailability(components)).toThrow(
        "Component quantity must be a positive number",
      );
    });

    it("throws error for negative quantity", () => {
      const components = [
        { stock: 10, quantity: 1 },
        { stock: 10, quantity: -2 },
      ];
      expect(() => calculateMixedBundleAvailability(components)).toThrow(
        "Component quantity must be a positive number",
      );
    });
  });
});

describe("inventory sync scenarios", () => {
  // These tests document the expected behavior for common scenarios

  describe("same-product bundle sync", () => {
    it("correctly calculates all pack sizes from base stock", () => {
      const physicalStock = 48;

      // Expected inventory levels for each variant
      const expected = {
        single: calculateBundleAvailability(physicalStock, 1),
        fourPack: calculateBundleAvailability(physicalStock, 4),
        sixPack: calculateBundleAvailability(physicalStock, 6),
        twentyFourPack: calculateBundleAvailability(physicalStock, 24),
      };

      expect(expected.single).toBe(48);
      expect(expected.fourPack).toBe(12);
      expect(expected.sixPack).toBe(8);
      expect(expected.twentyFourPack).toBe(2);
    });

    it("handles purchase of one 24-pack (reduces base by 24)", () => {
      const physicalStock = 48 - 24; // After selling one 24-pack

      const expected = {
        single: calculateBundleAvailability(physicalStock, 1),
        fourPack: calculateBundleAvailability(physicalStock, 4),
        sixPack: calculateBundleAvailability(physicalStock, 6),
        twentyFourPack: calculateBundleAvailability(physicalStock, 24),
      };

      expect(expected.single).toBe(24);
      expect(expected.fourPack).toBe(6);
      expect(expected.sixPack).toBe(4);
      expect(expected.twentyFourPack).toBe(1);
    });

    it("handles partial restocking", () => {
      const physicalStock = 33; // Odd number after some sales and partial restock

      const expected = {
        single: calculateBundleAvailability(physicalStock, 1),
        fourPack: calculateBundleAvailability(physicalStock, 4),
        sixPack: calculateBundleAvailability(physicalStock, 6),
        twentyFourPack: calculateBundleAvailability(physicalStock, 24),
      };

      expect(expected.single).toBe(33);
      expect(expected.fourPack).toBe(8); // 8.25 rounded down
      expect(expected.sixPack).toBe(5); // 5.5 rounded down
      expect(expected.twentyFourPack).toBe(1); // 1.375 rounded down
    });
  });

  describe("mixed bundle sync", () => {
    it("updates when any component stock changes", () => {
      // Initial state: variety pack with plenty of stock
      const initialComponents = [
        { stock: 100, quantity: 2 },
        { stock: 100, quantity: 2 },
        { stock: 100, quantity: 2 },
      ];
      expect(calculateMixedBundleAvailability(initialComponents)).toBe(50);

      // After selling some of component B directly (not via variety pack)
      const afterSaleComponents = [
        { stock: 100, quantity: 2 },
        { stock: 20, quantity: 2 }, // Sold 80 units of component B
        { stock: 100, quantity: 2 },
      ];
      expect(calculateMixedBundleAvailability(afterSaleComponents)).toBe(10);
    });
  });
});
