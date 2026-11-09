import "server-only";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { WorkspaceError, type WorkspaceErrorCode } from "./repository";

/**
 * Shared pieces for the /api/workspaces routes. The actor is always the
 * signed-in Clerk user; ids in the URL or body only select, and the database
 * decides whether that user may act on them.
 */

/** Refusals that hide whether the record exists at all. */
const NOT_FOUND: ReadonlySet<WorkspaceErrorCode> = new Set([
  "workspace_access_denied",
  "transfer_access_denied",
  "transfer_not_found",
  "shop_not_bound",
  "campaign_not_found",
]);

export async function signedInUser(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
export const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
export const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

export function workspaceErrorResponse(error: unknown, context: string): NextResponse {
  if (error instanceof WorkspaceError) {
    return NOT_FOUND.has(error.code) ? notFound() : NextResponse.json({ error: error.code }, { status: 409 });
  }
  console.error(`${context} failed:`, error instanceof Error ? error.message : "unknown error");
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
