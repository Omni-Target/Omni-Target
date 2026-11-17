import "server-only";
import { supabaseAdmin } from "@/platform/supabase";

/** Whether this template was sent to the user since the given time. An unreadable log counts as not sent. */
export async function emailSentSince(userId: string, template: string, since: Date): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("email_log")
    .select("id")
    .eq("user_id", userId)
    .eq("template", template)
    .gte("sent_at", since.toISOString())
    .limit(1)
    .maybeSingle();
  if (error) console.error("Email log unavailable:", error.message);
  return Boolean(data);
}

/** Records a sent template so the next run does not repeat it. */
export async function recordEmailSent(userId: string, template: string): Promise<void> {
  const { error } = await supabaseAdmin.from("email_log").insert({ user_id: userId, template });
  if (error) console.error("Could not record the sent email:", error.message);
}
