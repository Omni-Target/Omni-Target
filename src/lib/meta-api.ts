/**
 * The one Meta Graph and Marketing API version Omnitarget calls (Phase 5, task 2).
 *
 * Meta's changelog (https://developers.facebook.com/docs/graph-api/changelog/versions/, read 2026-11-28):
 * Graph API v19.0 expired on 2026-05-21 and Marketing API v19.0 on 2025-02-04; calls to them were answered only
 * because Meta upgrades expired versions automatically. v25.0 is the only Marketing API version without an expiry
 * (Graph v25.0 runs to 2028-07-29), so one version serves both: interest search and the Conversions API (Marketing),
 * and OAuth, permissions and pages (Graph). Change it here, and nowhere else (meta-api.test.ts enforces that).
 */
export const META_API_VERSION = "v25.0";

/** Base URL for Graph and Marketing API calls. */
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

/** The OAuth login dialog, at the same version. */
export const META_OAUTH_DIALOG = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`;
