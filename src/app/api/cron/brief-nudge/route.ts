import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { briefNudgeEmailHtml } from '@/emails/brief-nudge';
import { clerkClient } from '@clerk/nextjs/server';

export const maxDuration = 60; // 60 seconds

export async function GET(request: Request) {
  try {
    // Fail closed: if CRON_SECRET is not configured, deny rather than allow.
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const targetDate = new Date();
    targetDate.setHours(targetDate.getHours() - 48);

    // Get all user integrations created more than 48 hours ago
    const { data: integrations, error: intError } = await supabaseAdmin
      .from('user_integrations')
      .select('clerk_user_id, created_at')
      .lte('created_at', targetDate.toISOString());

    if (intError || !integrations) {
      console.error('Error fetching integrations:', intError);
      return NextResponse.json({ error: 'Failed to fetch integrations' }, { status: 500 });
    }

    let sentCount = 0;

    for (const integration of integrations) {
      const userId = integration.clerk_user_id;
      if (!userId) continue;

      // Check if user has any campaigns (briefs)
      const { data: campaigns, error: campError } = await supabaseAdmin
        .from('campaigns')
        .select('id')
        .eq('clerk_user_id', userId)
        .limit(1);
      
      if (!campError && campaigns && campaigns.length === 0) {
        // User has 0 briefs. Attempt to send nudge email.
        // The sendEmail utility will prevent duplicate sends using email_log.
        try {
          const user = await (await clerkClient()).users.getUser(userId);
          const email = user.emailAddresses[0]?.emailAddress;
          
          if (email) {
            const result = await sendEmail({
              to: email,
              subject: "You haven't run your first brief yet",
              html: briefNudgeEmailHtml(),
              userId: userId,
              templateName: "brief-nudge"
            });
            
            if (result.success && !result.skipped) {
              sentCount++;
            }
          }
        } catch (emailErr) {
          console.error(`Failed to send brief nudge to user ${userId}:`, emailErr);
        }
      }
    }

    return NextResponse.json({ success: true, processed: integrations.length, sent: sentCount });
  } catch (err) {
    console.error('Cron job error:', err);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
