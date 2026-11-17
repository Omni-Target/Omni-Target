import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { sendEmail } from '@/lib/email';
import { briefNudgeEmailHtml } from '@/emails/brief-nudge';
import { captureBackgroundFailure } from '@/lib/observability/capture';
import { safeEqual } from '@/lib/shopify-oauth';
import { briefNudgeCandidates } from '@/modules/notifications/email-log';

export const maxDuration = 60; // 60 seconds

/** Most accounts nudged per run; the rest follow on the next run. */
const MAX_PER_RUN = 200;
/** Clerk returns at most 100 users per lookup. */
const LOOKUP_BATCH = 100;

/**
 * Daily nudge to accounts connected over 48 hours ago that have not saved a
 * brief. One query finds them (migration 0028) and Clerk is asked for their
 * email addresses 100 at a time, instead of two lookups per account (DATA-07).
 * sendEmail claims each send, so an account is nudged at most once a week.
 */
export async function GET(request: Request) {
  // Fail closed: if CRON_SECRET is not configured, deny rather than allow.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !safeEqual(request.headers.get('authorization') ?? '', `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const cutoff = new Date(Date.now() - 48 * 3600 * 1000);
    let candidates: string[];
    try {
      candidates = await briefNudgeCandidates(cutoff, MAX_PER_RUN);
    } catch (error) {
      console.error('Error fetching nudge candidates:', error instanceof Error ? error.message : 'unknown');
      return NextResponse.json({ error: 'Failed to fetch integrations' }, { status: 500 });
    }

    const clerk = await clerkClient();
    let sentCount = 0;
    for (let i = 0; i < candidates.length; i += LOOKUP_BATCH) {
      const ids = candidates.slice(i, i + LOOKUP_BATCH);
      let users;
      try {
        users = (await clerk.users.getUserList({ userId: ids, limit: LOOKUP_BATCH })).data;
      } catch (error) {
        captureBackgroundFailure('cron-brief-nudge-lookup', error);
        continue;
      }
      for (const user of users) {
        const email = user.emailAddresses[0]?.emailAddress;
        if (!email) continue;
        try {
          const result = await sendEmail({
            to: email,
            subject: "You haven't run your first brief yet",
            html: briefNudgeEmailHtml(),
            userId: user.id,
            templateName: 'brief-nudge',
          });
          if (result.success && !result.skipped) sentCount++;
        } catch (error) {
          captureBackgroundFailure('cron-brief-nudge-email', error);
        }
      }
    }

    return NextResponse.json({ success: true, processed: candidates.length, sent: sentCount });
  } catch (err) {
    console.error('Cron job error:', err instanceof Error ? err.message : 'unknown');
    captureBackgroundFailure('cron-brief-nudge', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
