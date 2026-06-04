export function briefNudgeEmailHtml(): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0f0f0f;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <div style="font-size:24px;font-weight:bold;letter-spacing:-0.5px;margin-bottom:40px;">
      OMNI TARGET
    </div>

    <p style="margin:0 0 16px 0;font-size:16px;color:#e5e5e5;">
      Your store data is sitting there ready.
    </p>

    <p style="margin:0 0 16px 0;font-size:16px;color:#e5e5e5;">
      We've identified your best products to advertise — Gateway Products that convert cold traffic into first-time buyers. You're one brief away from knowing exactly what to run, who to target, and how much to spend.
    </p>

    <p style="margin:0 0 24px 0;font-size:16px;color:#e5e5e5;">
      Your free credit doesn't expire. Use it when you're ready.
    </p>

    <a href="https://app.omnitarget.co/dashboard" style="background-color:#9333ea;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500;display:inline-block;margin-bottom:24px;">
      See Your Store Intelligence →
    </a>

    <p style="margin:0 0 40px 0;font-size:16px;color:#e5e5e5;">
      — The Omni Target Team
    </p>

    <div style="border-top:1px solid #333333;padding-top:24px;font-size:14px;color:#888888;">
      <p style="margin:0;">
        Omni Target · hello@app.omnitarget.co · You're receiving this because you installed Omni Target on your Shopify store
      </p>
      <p style="margin:8px 0 0 0;">
        <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#888888;text-decoration:underline;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}
