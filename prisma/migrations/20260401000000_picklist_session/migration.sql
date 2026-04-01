-- Short-lived session for passing order IDs from admin extensions to the Pick List page
CREATE TABLE "PickListSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "orderIds" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "PickListSession_shopId_idx" ON "PickListSession"("shopId");
CREATE INDEX "PickListSession_createdAt_idx" ON "PickListSession"("createdAt");
