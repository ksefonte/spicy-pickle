-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentGid" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expandOnPick" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Bundle_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BundleChild" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bundleId" TEXT NOT NULL,
    "childGid" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    CONSTRAINT "BundleChild_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BinLocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BinLocation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bundleId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Bundle_shopId_idx" ON "Bundle"("shopId");

-- CreateIndex
CREATE INDEX "Bundle_parentGid_idx" ON "Bundle"("parentGid");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_shopId_parentGid_key" ON "Bundle"("shopId", "parentGid");

-- CreateIndex
CREATE INDEX "BundleChild_childGid_idx" ON "BundleChild"("childGid");

-- CreateIndex
CREATE UNIQUE INDEX "BundleChild_bundleId_childGid_key" ON "BundleChild"("bundleId", "childGid");

-- CreateIndex
CREATE INDEX "BinLocation_shopId_idx" ON "BinLocation"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "BinLocation_shopId_variantGid_key" ON "BinLocation"("shopId", "variantGid");

-- CreateIndex
CREATE INDEX "SyncLock_bundleId_idx" ON "SyncLock"("bundleId");

-- CreateIndex
CREATE INDEX "SyncLock_expiresAt_idx" ON "SyncLock"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");
