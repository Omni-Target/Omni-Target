import "server-only";
import { supabaseAdmin } from "@/platform/supabase";

/**
 * Claims one send of a template to a user (migration 0028): null when it was
 * already sent or claimed within the window, even if two runs overlap. The
 * claim is the log entry; give it back with releaseEmailClaim when the send
 * fails. Throws when the log cannot be reached, so nothing is sent twice.
 */
export async function claimEmailSend(userId: string, template: string, withinDays: number): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("claim_email_send", { p_user: userId, p_template: template, p_window: `${withinDays} days` });
  if (error) throw new Error(`Email log unavailable: ${error.message}`);
  return (data as string | null) ?? null;
}

export async function releaseEmailClaim(claimId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("release_email_claim", { p_claim: claimId });
  if (error) console.error("Could not release the email claim:", error.message);
}

/** Accounts due a brief nudge (migration 0028), oldest first, at most `limit`. */
export async function briefNudgeCandidates(createdBefore: Date, limit: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin.rpc("brief_nudge_candidates", { p_created_before: createdBefore.toISOString(), p_limit: limit });
  if (error) throw new Error(`Nudge candidates unavailable: ${error.message}`);
  return (data as string[] | null) ?? [];
}
