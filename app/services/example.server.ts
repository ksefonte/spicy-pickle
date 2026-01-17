/**
 * Example service file to demonstrate testing setup.
 * This file will be replaced with actual inventory-sync and picklist services.
 */

/**
 * Calculates the available quantity for a bundle variant based on physical stock.
 * @param physicalStock - The number of physical base units available
 * @param multiplier - The number of base units in this bundle variant (e.g., 24 for a 24-pack)
 * @returns The number of complete bundle variants available
 */
export function calculateBundleAvailability(
  physicalStock: number,
  multiplier: number,
): number {
  if (multiplier <= 0) {
    throw new Error("Multiplier must be a positive number");
  }
  return Math.floor(physicalStock / multiplier);
}

/**
 * Calculates availability for a mixed bundle (variety pack) based on component stock.
 * @param components - Array of {stock, quantity} for each component in the bundle
 * @returns The number of complete mixed bundles available
 */
export function calculateMixedBundleAvailability(
  components: Array<{ stock: number; quantity: number }>,
): number {
  if (components.length === 0) {
    return 0;
  }

  const availabilities = components.map((component) => {
    if (component.quantity <= 0) {
      throw new Error("Component quantity must be a positive number");
    }
    return Math.floor(component.stock / component.quantity);
  });

  return Math.min(...availabilities);
}
