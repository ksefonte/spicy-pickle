/**
 * REST API for Bundle Management
 *
 * Provides external access to bundle configuration.
 * Authenticates via Shopify session (for embedded apps) or API key (for external).
 *
 * Endpoints:
 * - GET /api/bundles - List all bundles
 * - POST /api/bundles - Create a new bundle
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncBundleMetafield } from "../services/metafields.server";

interface CreateBundleRequest {
  name: string;
  parentGid: string;
  expandOnPick?: boolean;
  children: Array<{
    childGid: string;
    quantity: number;
  }>;
}

/**
 * GET /api/bundles - List all bundles for the authenticated shop
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const bundles = await db.bundle.findMany({
    where: { shopId: shop },
    include: {
      children: {
        select: {
          id: true,
          childGid: true,
          quantity: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return Response.json({
    bundles: bundles.map((bundle) => ({
      id: bundle.id,
      name: bundle.name,
      parentGid: bundle.parentGid,
      expandOnPick: bundle.expandOnPick,
      createdAt: bundle.createdAt.toISOString(),
      updatedAt: bundle.updatedAt.toISOString(),
      children: bundle.children.map((child) => ({
        id: child.id,
        childGid: child.childGid,
        quantity: child.quantity,
      })),
    })),
  });
};

/**
 * POST /api/bundles - Create a new bundle
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let body: CreateBundleRequest;
  try {
    body = (await request.json()) as CreateBundleRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate required fields
  if (!body.name || typeof body.name !== "string") {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  if (!body.parentGid || typeof body.parentGid !== "string") {
    return Response.json({ error: "parentGid is required" }, { status: 400 });
  }

  if (!Array.isArray(body.children) || body.children.length === 0) {
    return Response.json(
      { error: "children array with at least one item is required" },
      { status: 400 },
    );
  }

  // Validate children
  for (const child of body.children) {
    if (!child.childGid || typeof child.childGid !== "string") {
      return Response.json(
        { error: "Each child must have a childGid" },
        { status: 400 },
      );
    }
    if (typeof child.quantity !== "number" || child.quantity < 1) {
      return Response.json(
        { error: "Each child must have a quantity >= 1" },
        { status: 400 },
      );
    }
  }

  // Ensure shop exists
  await db.shop.upsert({
    where: { id: shop },
    create: { id: shop },
    update: {},
  });

  // Check for duplicate
  const existing = await db.bundle.findUnique({
    where: {
      shopId_parentGid: {
        shopId: shop,
        parentGid: body.parentGid,
      },
    },
  });

  if (existing) {
    return Response.json(
      { error: "A bundle already exists for this parent variant" },
      { status: 409 },
    );
  }

  // Create bundle
  const bundle = await db.bundle.create({
    data: {
      shopId: shop,
      name: body.name,
      parentGid: body.parentGid,
      expandOnPick: body.expandOnPick ?? false,
      children: {
        create: body.children.map((child) => ({
          childGid: child.childGid,
          quantity: child.quantity,
        })),
      },
    },
    include: {
      children: true,
    },
  });

  // Sync to metafield
  try {
    await syncBundleMetafield(admin, bundle);
  } catch (error) {
    console.error("Failed to sync bundle metafield:", error);
  }

  return Response.json(
    {
      bundle: {
        id: bundle.id,
        name: bundle.name,
        parentGid: bundle.parentGid,
        expandOnPick: bundle.expandOnPick,
        createdAt: bundle.createdAt.toISOString(),
        updatedAt: bundle.updatedAt.toISOString(),
        children: bundle.children.map((child) => ({
          id: child.id,
          childGid: child.childGid,
          quantity: child.quantity,
        })),
      },
    },
    { status: 201 },
  );
};
