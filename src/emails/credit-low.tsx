export function creditLowEmailHtml(): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0f0f0f;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <div style="font-size:24px;font-weight:bold;letter-spacing:-0.5px;margin-bottom:40px;">
      OMNI TARGET
    </div>

    <p style="margin:0 0 16px 0;font-size:16px;color:#e5e5e5;">
      Heads up — you're down to your last brief credit.
    </p>

    <p style="margin:0 0 24px 0;font-size:16px;color:#e5e5e5;">
      Credits are valid for 12 months from purchase date. When you're ready to top up, we're here.
    </p>

    <a href="https://app.omnitarget.co/dashboard" style="background-color:#9333ea;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500;display:inline-block;margin-bottom:24px;">
      Top Up Credits →
    </a>

    <p style="margin:0 0 40px 0;font-size:16px;color:#e5e5e5;">
      — The Omni Target Team
    </p>

    <div style="border-top:1px solid #333333;padding-top:24px;font-size:14px;color:#888888;">
      <p style="margin:0 0 8px 0;">
        Credits are valid for 12 months from purchase date.
      </p>
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
