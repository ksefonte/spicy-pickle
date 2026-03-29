/*
  Warnings:

  - You are about to drop the column `name` on the `Bundle` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "SupplierSku" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "supplierSku" TEXT NOT NULL,
    "supplierSkuQty" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupplierSku_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Bundle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "parentGid" TEXT NOT NULL,
    "parentTitle" TEXT,
    "parentSku" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expandOnPick" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Bundle_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Bundle" ("createdAt", "expandOnPick", "id", "parentGid", "shopId", "updatedAt") SELECT "createdAt", "expandOnPick", "id", "parentGid", "shopId", "updatedAt" FROM "Bundle";
DROP TABLE "Bundle";
ALTER TABLE "new_Bundle" RENAME TO "Bundle";
CREATE INDEX "Bundle_shopId_idx" ON "Bundle"("shopId");
CREATE INDEX "Bundle_parentGid_idx" ON "Bundle"("parentGid");
CREATE UNIQUE INDEX "Bundle_shopId_parentGid_key" ON "Bundle"("shopId", "parentGid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SupplierSku_shopId_idx" ON "SupplierSku"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierSku_shopId_variantGid_key" ON "SupplierSku"("shopId", "variantGid");
