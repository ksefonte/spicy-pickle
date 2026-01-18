-- CreateTable: SupplierSku
CREATE TABLE "SupplierSku" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "supplierSku" TEXT NOT NULL,
    "supplierSkuQty" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierSku_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Bundle - drop name column, add parentTitle and parentSku
ALTER TABLE "Bundle" DROP COLUMN "name";
ALTER TABLE "Bundle" ADD COLUMN "parentTitle" TEXT;
ALTER TABLE "Bundle" ADD COLUMN "parentSku" TEXT;

-- CreateIndex
CREATE INDEX "SupplierSku_shopId_idx" ON "SupplierSku"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierSku_shopId_variantGid_key" ON "SupplierSku"("shopId", "variantGid");

-- AddForeignKey
ALTER TABLE "SupplierSku" ADD CONSTRAINT "SupplierSku_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
