import { NextResponse } from 'next/server';
import { listAccountsCreatedBefore } from '@/lib/db';
import { creatorHasAnyCampaign } from '@/modules/campaigns/repository';
import { sendEmail } from '@/lib/email';
import { briefNudgeEmailHtml } from '@/emails/brief-nudge';
import { clerkClient } from '@clerk/nextjs/server';
import { captureBackgroundFailure } from '@/lib/observability/capture';

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
    let integrations: Awaited<ReturnType<typeof listAccountsCreatedBefore>>;
    try {
      integrations = await listAccountsCreatedBefore(targetDate);
    } catch (intError) {
      console.error('Error fetching integrations:', intError instanceof Error ? intError.message : 'unknown');
      return NextResponse.json({ error: 'Failed to fetch integrations' }, { status: 500 });
    }

    let sentCount = 0;

    for (const integration of integrations) {
      const userId = integration.clerk_user_id;
      if (!userId) continue;

      // Check if user has any campaigns (briefs); when unknown, send nothing.
      const hasBrief = await creatorHasAnyCampaign(userId).catch(() => null);

      if (hasBrief === false) {
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
          captureBackgroundFailure('cron-brief-nudge-email', emailErr);
        }
      }
    }

    return NextResponse.json({ success: true, processed: integrations.length, sent: sentCount });
  } catch (err) {
    console.error('Cron job error:', err);
    captureBackgroundFailure('cron-brief-nudge', err);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
