import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

/**
 * Debug endpoint for monitoring app state.
 *
 * GET /api/debug - Returns current app state including:
 * - Database connection status
 * - Bundle count
 * - Recent sync locks (webhook deduplication)
 * - Bin location count
 *
 * This is useful for debugging webhook processing and inventory sync.
 *
 * NOTE: In production, you may want to protect this endpoint or remove it.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const verbose = url.searchParams.get("verbose") === "true";

  try {
    // Test database connection
    const dbStatus = await testDatabase();

    // Get counts
    const [bundleCount, binLocationCount, shopCount] = await Promise.all([
      db.bundle.count(),
      db.binLocation.count(),
      db.shop.count(),
    ]);

    // Get recent sync locks (shows webhook activity)
    const recentSyncLocks = await db.syncLock.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    // Get bundles with children if verbose
    let bundles: unknown[] = [];
    if (verbose) {
      bundles = await db.bundle.findMany({
        include: {
          children: true,
        },
        take: 20,
      });
    }

    const response = {
      status: "ok",
      timestamp: new Date().toISOString(),
      database: dbStatus,
      counts: {
        shops: shopCount,
        bundles: bundleCount,
        binLocations: binLocationCount,
      },
      recentWebhookActivity: recentSyncLocks.map((lock) => ({
        id: lock.id,
        bundleId: lock.bundleId,
        createdAt: lock.createdAt,
        expiresAt: lock.expiresAt,
      })),
      ...(verbose && { bundles }),
    };

    return Response.json(response, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[Debug] Error:", error);
    return Response.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
};

async function testDatabase(): Promise<{
  connected: boolean;
  latency?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    return {
      connected: true,
      latency: Date.now() - start,
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
