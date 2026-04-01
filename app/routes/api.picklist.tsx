import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    return cors(
      Response.json({ error: "Missing session param" }, { status: 400 }),
    );
  }

  const picklistSession = await prisma.pickListSession.findUnique({
    where: { id: sessionId },
  });

  if (!picklistSession || picklistSession.shopId !== session.shop) {
    return cors(Response.json({ error: "Session not found" }, { status: 404 }));
  }

  await prisma.pickListSession.delete({ where: { id: sessionId } });

  let orderIds: string[];
  try {
    orderIds = JSON.parse(picklistSession.orderIds) as string[];
  } catch {
    return cors(Response.json({ error: "Corrupted session" }, { status: 500 }));
  }

  return cors(Response.json({ orderIds }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session, cors } = await authenticate.admin(request);

  const body = (await request.json()) as {
    intent?: string;
    orderIds?: string[];
  };

  if (body.intent === "prepare") {
    if (!Array.isArray(body.orderIds) || body.orderIds.length === 0) {
      return cors(
        Response.json({ error: "orderIds is required" }, { status: 400 }),
      );
    }

    await cleanupExpiredSessions();

    const picklistSession = await prisma.pickListSession.create({
      data: {
        shopId: session.shop,
        orderIds: JSON.stringify(body.orderIds),
      },
    });

    return cors(Response.json({ sessionId: picklistSession.id }));
  }

  return cors(Response.json({ error: "Unknown intent" }, { status: 400 }));
};

async function cleanupExpiredSessions() {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS);
  await prisma.pickListSession.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
}
