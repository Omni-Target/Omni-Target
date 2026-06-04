import * as React from 'react';
import { Resend } from 'resend';
import { supabaseAdmin } from './db';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  react: React.ReactNode;
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
  react, 
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
    
    const { data: existingLog } = await supabaseAdmin
      .from('email_log')
      .select('id')
      .eq('user_id', userId)
      .eq('template', templateName)
      .gte('sent_at', sevenDaysAgo.toISOString())
      .limit(1)
      .maybeSingle();

    if (existingLog) {
      console.log(`Skipping email: ${templateName} already sent to ${userId} within 7 days`);
      return { success: true, skipped: true };
    }
  }

  try {
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      react,
    });

    if (error) {
      console.error('Resend API error:', error);
      return { success: false, error };
    }

    if (userId && templateName) {
      await supabaseAdmin.from('email_log').insert({
        user_id: userId,
        template: templateName
      });
    }

    return { success: true, data };
  } catch (error) {
    console.error('Unexpected error sending email:', error);
    return { success: false, error };
  }
}
