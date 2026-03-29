-- Add sync toggles
ALTER TABLE "Shop" ADD COLUMN "syncEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Bundle" ADD COLUMN "syncEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Create new Bin model
CREATE TABLE "Bin" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bin_pkey" PRIMARY KEY ("id")
);

-- Create new BinVariant model
CREATE TABLE "BinVariant" (
    "id" TEXT NOT NULL,
    "binId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BinVariant_pkey" PRIMARY KEY ("id")
);

-- Bin indexes and constraints
CREATE UNIQUE INDEX "Bin_shopId_name_key" ON "Bin"("shopId", "name");
CREATE INDEX "Bin_shopId_idx" ON "Bin"("shopId");

-- BinVariant indexes and constraints
CREATE UNIQUE INDEX "BinVariant_shopId_variantGid_key" ON "BinVariant"("shopId", "variantGid");
CREATE UNIQUE INDEX "BinVariant_binId_variantGid_key" ON "BinVariant"("binId", "variantGid");
CREATE INDEX "BinVariant_variantGid_idx" ON "BinVariant"("variantGid");

-- Foreign keys
ALTER TABLE "Bin" ADD CONSTRAINT "Bin_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BinVariant" ADD CONSTRAINT "BinVariant_binId_fkey" FOREIGN KEY ("binId") REFERENCES "Bin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop old BinLocation table
DROP TABLE IF EXISTS "BinLocation";
