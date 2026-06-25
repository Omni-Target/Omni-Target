export function briefNudgeEmailHtml(): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#333;background-color:#ffffff;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <div style="margin-bottom:32px;">
      <a href="https://app.omnitarget.co" style="text-decoration:none;">
        <img src="https://res.cloudinary.com/denwiqjid/image/upload/v1779707457/omni_target_logo_ae2epf.png" alt="Omni Target" height="28" style="display:block;border:none;outline:none;text-decoration:none;" />
      </a>
    </div>

    <p style="margin:0 0 16px 0;">Hi there,</p>

    <p style="margin:0 0 16px 0;">
      Your store data is sitting there ready.
    </p>

    <p style="margin:0 0 16px 0;">
      We've identified your best products to advertise — Gateway Products that convert cold traffic into first-time buyers. You're one brief away from knowing exactly what to run, who to target, and how much to spend.
    </p>

    <p style="margin:0 0 24px 0;">
      Your free credit doesn't expire. Use it when you're ready.
    </p>

    <p style="margin:0 0 32px 0;">
      <a href="https://app.omnitarget.co/dashboard" style="color:#9333ea;font-weight:500;text-decoration:none;">See Your Store Intelligence →</a>
    </p>

    <p style="margin:0 0 40px 0;">
      Best,<br>
      The Omni Target Team
    </p>

    <div style="border-top:1px solid #eeeeee;padding-top:24px;font-size:12px;color:#888888;line-height:1.5;">
      <p style="margin:0 0 4px 0;"><strong>Omni Target</strong></p>
      <p style="margin:0 0 12px 0;">
        <a href="mailto:hello@app.omnitarget.co" style="color:#888888;text-decoration:none;">hello@app.omnitarget.co</a>
      </p>
      <p style="margin:0 0 8px 0;">
        You're receiving this because you installed Omni Target on your Shopify store.
      </p>
      <p style="margin:0;">
        <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#888888;text-decoration:underline;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}
