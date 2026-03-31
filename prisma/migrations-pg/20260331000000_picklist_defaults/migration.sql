-- Add pick list default settings to Shop
ALTER TABLE "Shop" ADD COLUMN "picklistUnfulfilled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Shop" ADD COLUMN "picklistPartial" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Shop" ADD COLUMN "picklistFulfilled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "picklistShippingOnly" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Shop" ADD COLUMN "picklistMode" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "Shop" ADD COLUMN "picklistSortBy" TEXT NOT NULL DEFAULT 'bin';
ALTER TABLE "Shop" ADD COLUMN "picklistSortDir" TEXT NOT NULL DEFAULT 'asc';
