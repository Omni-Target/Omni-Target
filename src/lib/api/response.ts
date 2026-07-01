import { NextResponse } from "next/server";

/**
 * Consistent JSON helpers for API route handlers.
 *
 * Goals:
 *  - Uniform response shape across routes.
 *  - Never leak internal error details (stack traces, DB errors, provider error
 *    objects) to the client. Full detail is logged server-side instead.
 */

export interface ApiErrorBody {
  error: string;
  code?: string;
}

/** A client-safe error response. `message` must not contain internal details. */
export function apiError(
  message: string,
  status = 400,
  code?: string
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    code ? { error: message, code } : { error: message },
    { status }
  );
}

/** A success response. */
export function apiOk<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

/**
 * Logs the full error server-side (with a context tag) and returns a generic,
 * client-safe 500. Use in catch blocks so internals are never exposed.
 */
export function apiServerError(
  context: string,
  error: unknown,
  message = "Something went wrong. Please try again."
): NextResponse<ApiErrorBody> {
  console.error(`[${context}]`, error);
  return apiError(message, 500);
}
