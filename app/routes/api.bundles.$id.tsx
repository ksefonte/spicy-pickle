/**
 * REST API for Individual Bundle Management
 *
 * Endpoints:
 * - GET /api/bundles/:id - Get a single bundle
 * - PUT /api/bundles/:id - Update a bundle
 * - DELETE /api/bundles/:id - Delete a bundle
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  updateBundleMetaobjects,
  deleteBundleMetaobjects,
} from "../services/metaobject-writes.server";

interface UpdateBundleRequest {
  parentTitle?: string;
  parentSku?: string;
  expandOnPick?: boolean;
  children?: Array<{
    childGid: string;
    quantity: number;
  }>;
}

/**
 * GET /api/bundles/:id - Get a single bundle
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const bundleId = params.id;

  if (!bundleId) {
    return Response.json({ error: "Bundle ID required" }, { status: 400 });
  }

  const bundle = await db.bundle.findUnique({
    where: {
      id: bundleId,
      shopId: shop,
    },
    include: {
      children: {
        select: {
          id: true,
          childGid: true,
          quantity: true,
        },
      },
    },
  });

  if (!bundle) {
    return Response.json({ error: "Bundle not found" }, { status: 404 });
  }

  return Response.json({
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
  });
};

/**
 * PUT/DELETE /api/bundles/:id
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const bundleId = params.id;

  if (!bundleId) {
    return Response.json({ error: "Bundle ID required" }, { status: 400 });
  }

  // DELETE
  if (request.method === "DELETE") {
    const bundle = await db.bundle.findUnique({
      where: { id: bundleId, shopId: shop },
    });

    if (!bundle) {
      return Response.json({ error: "Bundle not found" }, { status: 404 });
    }

    await deleteBundleMetaobjects(admin, shop, bundle.parentGid);

    return Response.json({ deleted: true });
  }

  // PUT
  if (request.method === "PUT") {
    let body: UpdateBundleRequest;
    try {
      body = (await request.json()) as UpdateBundleRequest;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const existingBundle = await db.bundle.findUnique({
      where: { id: bundleId, shopId: shop },
    });

    if (!existingBundle) {
      return Response.json({ error: "Bundle not found" }, { status: 404 });
    }

    // Validate children if provided
    if (body.children !== undefined) {
      if (!Array.isArray(body.children) || body.children.length === 0) {
        return Response.json(
          { error: "children must be a non-empty array" },
          { status: 400 },
        );
      }

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
    }

    // If children are being updated, use the full metaobject write path.
    // Otherwise, only update Prisma metadata fields.
    if (body.children !== undefined) {
      await updateBundleMetaobjects(
        admin,
        shop,
        existingBundle.parentGid,
        body.children,
        {
          parentTitle: body.parentTitle ?? existingBundle.parentTitle,
          parentSku: body.parentSku ?? existingBundle.parentSku,
          expandOnPick: body.expandOnPick ?? existingBundle.expandOnPick,
        },
      );
    } else {
      const updateData: {
        parentTitle?: string;
        parentSku?: string;
        expandOnPick?: boolean;
      } = {};

      if (body.parentTitle !== undefined)
        updateData.parentTitle = body.parentTitle;
      if (body.parentSku !== undefined) updateData.parentSku = body.parentSku;
      if (body.expandOnPick !== undefined)
        updateData.expandOnPick = body.expandOnPick;

      await db.bundle.update({
        where: { id: bundleId, shopId: shop },
        data: updateData,
      });
    }

    const bundle = await db.bundle.findUnique({
      where: { id: bundleId, shopId: shop },
      include: { children: true },
    });

    if (!bundle) {
      return Response.json(
        { error: "Bundle not found after update" },
        { status: 500 },
      );
    }

    return Response.json({
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
    });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};
