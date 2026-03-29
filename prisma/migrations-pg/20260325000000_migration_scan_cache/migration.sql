-- CreateTable
CREATE TABLE "MigrationScanCache" (
    "id" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "productsJson" TEXT NOT NULL,
    "namespacesJson" TEXT NOT NULL,
    "diagnosticsJson" TEXT NOT NULL,
    "countsJson" TEXT NOT NULL,

    CONSTRAINT "MigrationScanCache_pkey" PRIMARY KEY ("id")
);
