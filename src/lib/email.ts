import { Resend } from 'resend';
import { emailSentSince, recordEmailSent } from '@/modules/notifications/email-log';

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

  // Prevent duplicate sends if userId and templateName are provided
  if (userId && templateName) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    if (await emailSentSince(userId, templateName, sevenDaysAgo)) {
      console.log(`Skipping email: ${templateName} already sent to ${userId} within 7 days`);
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
      return { success: false, error };
    }

    if (userId && templateName) {
      await recordEmailSent(userId, templateName);
    }

    return { success: true, data };
  } catch (error) {
    console.error('Unexpected error sending email:', error);
    return { success: false, error };
  }
}
