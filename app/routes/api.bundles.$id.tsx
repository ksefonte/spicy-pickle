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
  syncBundleMetafield,
  deleteBundleMetafield,
} from "../services/metafields.server";

interface UpdateBundleRequest {
  name?: string;
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

    // Delete metafield
    try {
      await deleteBundleMetafield(admin, bundle.parentGid);
    } catch (error) {
      console.error("Failed to delete bundle metafield:", error);
    }

    await db.bundle.delete({
      where: { id: bundleId, shopId: shop },
    });

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

    // Build update data
    const updateData: {
      name?: string;
      expandOnPick?: boolean;
      children?: {
        deleteMany: object;
        create: Array<{ childGid: string; quantity: number }>;
      };
    } = {};

    if (body.name !== undefined) {
      updateData.name = body.name;
    }

    if (body.expandOnPick !== undefined) {
      updateData.expandOnPick = body.expandOnPick;
    }

    if (body.children !== undefined) {
      updateData.children = {
        deleteMany: {},
        create: body.children.map((child) => ({
          childGid: child.childGid,
          quantity: child.quantity,
        })),
      };
    }

    const bundle = await db.bundle.update({
      where: { id: bundleId, shopId: shop },
      data: updateData,
      include: { children: true },
    });

    // Sync to metafield
    try {
      await syncBundleMetafield(admin, bundle);
    } catch (error) {
      console.error("Failed to sync bundle metafield:", error);
    }

    return Response.json({
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
    });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};
