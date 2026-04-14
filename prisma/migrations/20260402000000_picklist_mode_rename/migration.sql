-- Rename picklist mode values: "standard" → "configured", default → "resolved"
-- Existing shops with "standard" keep their configured-only behaviour under the new name.
UPDATE "Shop" SET "picklistMode" = 'configured' WHERE "picklistMode" = 'standard';

-- Update the column default for new shops
-- SQLite doesn't support ALTER COLUMN DEFAULT, so we leave the Prisma schema
-- as the source of truth for the default value on new rows.
