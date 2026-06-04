export function welcomeEmailHtml(): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0f0f0f;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <div style="font-size:24px;font-weight:bold;letter-spacing:-0.5px;margin-bottom:40px;">
      OMNI TARGET
    </div>

    <p style="margin:0 0 16px 0;font-size:16px;color:#e5e5e5;">
      Your store is connected.
    </p>

    <p style="margin:0 0 16px 0;font-size:16px;color:#e5e5e5;">
      We've pulled your products, orders, and buyer data — Omni Target is ready to turn it into your first Meta ad brief.
    </p>

    <p style="margin:0 0 24px 0;font-size:16px;color:#e5e5e5;">
      You have 1 free credit. Use it on any product and get a ready-to-launch campaign brief in under 2 minutes.
    </p>

    <a href="https://app.omnitarget.co/dashboard" style="background-color:#9333ea;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500;display:inline-block;margin-bottom:24px;">
      Create Your First Brief →
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
