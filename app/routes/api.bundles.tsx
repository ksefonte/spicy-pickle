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
import { createBundleAsMetaobjects } from "../services/metaobject-writes.server";

interface CreateBundleRequest {
  parentGid: string;
  parentTitle?: string;
  parentSku?: string;
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
      parentGid: bundle.parentGid,
      parentTitle: bundle.parentTitle,
      parentSku: bundle.parentSku,
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

  const bundleId = await createBundleAsMetaobjects(
    admin,
    shop,
    body.parentGid,
    body.children,
    {
      parentTitle: body.parentTitle || null,
      parentSku: body.parentSku || null,
      expandOnPick: body.expandOnPick ?? false,
    },
  );

  const bundle = await db.bundle.findUnique({
    where: { id: bundleId },
    include: { children: true },
  });

  if (!bundle) {
    return Response.json(
      { error: "Bundle created but not found" },
      { status: 500 },
    );
  }

  return Response.json(
    {
      bundle: {
        id: bundle.id,
        parentGid: bundle.parentGid,
        parentTitle: bundle.parentTitle,
        parentSku: bundle.parentSku,
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
