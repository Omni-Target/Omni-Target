import { Resend } from 'resend';
import { claimEmailSend, releaseEmailClaim } from '@/modules/notifications/email-log';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  userId?: string;
  templateName?: string;
}

/**
 * Generic email sending utility using Resend.
 * All email sending in the app should go through this function.
 */
export async function sendEmail({ 
  to, 
  subject, 
  html, 
  from = 'Omni Target <hello@app.omnitarget.co>',
  userId,
  templateName
}: SendEmailOptions) {
  if (!resend) {
    console.warn('RESEND_API_KEY is not set. Email not sent.');
    return { success: false, error: 'RESEND_API_KEY is not configured' };
  }

  // One send per user and template every 7 days, even when runs overlap: the
  // send is claimed first (migration 0028) and the claim given back on failure.
  let claim: string | null = null;
  if (userId && templateName) {
    try {
      claim = await claimEmailSend(userId, templateName, 7);
    } catch (error) {
      console.error('Email not sent: the send log is unavailable.', error instanceof Error ? error.message : 'unknown');
      return { success: false, error: 'email_log_unavailable' };
    }
    if (!claim) {
      console.log(`Skipping email: ${templateName} already sent within 7 days`);
      return { success: true, skipped: true };
    }
  }

  try {
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      html,
    });

    if (error) {
      console.error('Resend API error:', error);
      if (claim) await releaseEmailClaim(claim);
      return { success: false, error };
    }

    return { success: true, data };
  } catch (error) {
    console.error('Unexpected error sending email:', error);
    if (claim) await releaseEmailClaim(claim);
    return { success: false, error };
  }
}
