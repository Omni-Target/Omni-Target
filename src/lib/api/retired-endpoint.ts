/**
 * Retirement shim for legacy endpoints (Phase S0.6 — SEC-08).
 *
 * /api/generate-brief and /api/store/insights run paid LLM calls without
 * charging credits and have no callers in the app. Until the S2.4 observation
 * window confirms there are no external callers, they are disabled by default:
 * every hit is logged (structured, for evidence) and answered with 410.
 * Set LEGACY_AI_ENDPOINTS_ENABLED=true to restore them instantly if a
 * legitimate caller appears.
 */
export function legacyAiEndpointsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LEGACY_AI_ENDPOINTS_ENABLED === "true";
}

function logEndpointHit(event: string, endpoint: string, request: Request | null, userId: string | null): void {
  console.warn(
    JSON.stringify({
      event,
      endpoint,
      user: userId,
      user_agent: request?.headers.get("user-agent")?.slice(0, 200) ?? null,
      referer: request?.headers.get("referer")?.slice(0, 200) ?? null,
      at: new Date().toISOString(),
    }),
  );
}

/**
 * Observation log for routes with no known caller that are scheduled for
 * removal (SEC-08: /api/dashboard/stats, /api/media/proxy). Behaviour is
 * unchanged; every hit is recorded so the S2.4 observation window can prove
 * there are no legitimate external callers before deletion.
 */
export function logDeprecatedEndpointHit(endpoint: string, request: Request | null, userId: string | null): void {
  logEndpointHit("deprecated_endpoint_hit", endpoint, request, userId);
}

/** Returns a 410 response (after logging the hit) when the endpoint is retired, else null. */
export function retiredEndpointResponse(endpoint: string, request: Request | null, userId: string | null): Response | null {
  if (legacyAiEndpointsEnabled()) return null;
  logEndpointHit("retired_endpoint_hit", endpoint, request, userId);
  return Response.json(
    { error: "This endpoint has been retired.", code: "endpoint_retired" },
    { status: 410 },
  );
}
