import { describe, it, expect } from "vitest";
import {
  calculateBundleAvailability,
  calculateMixedBundleAvailability,
} from "./example.server";

describe("calculateBundleAvailability", () => {
  it("should calculate correct availability for a 24-pack with 48 units", () => {
    expect(calculateBundleAvailability(48, 24)).toBe(2);
  });

  it("should calculate correct availability for a 6-pack with 48 units", () => {
    expect(calculateBundleAvailability(48, 6)).toBe(8);
  });

  it("should calculate correct availability for a 4-pack with 48 units", () => {
    expect(calculateBundleAvailability(48, 4)).toBe(12);
  });

  it("should calculate correct availability for singles with 48 units", () => {
    expect(calculateBundleAvailability(48, 1)).toBe(48);
  });

  it("should floor the result when stock is not evenly divisible", () => {
    // 40 units / 6 = 6.66..., should floor to 6
    expect(calculateBundleAvailability(40, 6)).toBe(6);
  });

  it("should return 0 when stock is less than multiplier", () => {
    expect(calculateBundleAvailability(5, 24)).toBe(0);
  });

  it("should throw error for zero multiplier", () => {
    expect(() => calculateBundleAvailability(48, 0)).toThrow(
      "Multiplier must be a positive number",
    );
  });

  it("should throw error for negative multiplier", () => {
    expect(() => calculateBundleAvailability(48, -1)).toThrow(
      "Multiplier must be a positive number",
    );
  });
});

describe("calculateMixedBundleAvailability", () => {
  it("should return minimum availability across all components", () => {
    // Variety pack with 1 of each: Product A (stock: 10), Product B (stock: 5), Product C (stock: 8)
    // Should return 5 (limited by Product B)
    const components = [
      { stock: 10, quantity: 1 },
      { stock: 5, quantity: 1 },
      { stock: 8, quantity: 1 },
    ];
    expect(calculateMixedBundleAvailability(components)).toBe(5);
  });

  it("should handle different quantities per component", () => {
    // Bundle with 2x Product A (stock: 10) and 1x Product B (stock: 4)
    // Product A: 10 / 2 = 5, Product B: 4 / 1 = 4
    // Should return 4
    const components = [
      { stock: 10, quantity: 2 },
      { stock: 4, quantity: 1 },
    ];
    expect(calculateMixedBundleAvailability(components)).toBe(4);
  });

  it("should return 0 for empty components array", () => {
    expect(calculateMixedBundleAvailability([])).toBe(0);
  });

  it("should return 0 when any component has zero stock", () => {
    const components = [
      { stock: 10, quantity: 1 },
      { stock: 0, quantity: 1 },
    ];
    expect(calculateMixedBundleAvailability(components)).toBe(0);
  });

  it("should throw error for zero quantity component", () => {
    const components = [{ stock: 10, quantity: 0 }];
    expect(() => calculateMixedBundleAvailability(components)).toThrow(
      "Component quantity must be a positive number",
    );
  });
});
