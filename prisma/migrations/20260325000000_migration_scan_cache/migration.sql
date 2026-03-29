-- CreateTable
CREATE TABLE "MigrationScanCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scannedAt" DATETIME NOT NULL,
    "productsJson" TEXT NOT NULL,
    "namespacesJson" TEXT NOT NULL,
    "diagnosticsJson" TEXT NOT NULL,
    "countsJson" TEXT NOT NULL
);
