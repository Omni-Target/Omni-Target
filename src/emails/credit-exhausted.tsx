export function creditExhaustedEmailHtml(): string {
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
      You've briefed every credit — that's a founder who's moving.
    </p>

    <p style="margin:0 0 16px 0;">
      Ready to keep going? Pick the pack that fits where you are:
    </p>

    <ul style="padding:0;margin:0 0 16px 20px;color:#333;font-size:16px;">
      <li style="margin-bottom:8px;">Starter — 5 briefs / $39</li>
      <li style="margin-bottom:8px;">Growth — 15 briefs / $99</li>
      <li style="margin-bottom:8px;">Scale — 30 briefs / $179</li>
    </ul>

    <p style="margin:0 0 24px 0;">
      Credits are valid for 12 months from purchase date and never auto-renew.
    </p>

    <p style="margin:0 0 32px 0;">
      <a href="https://app.omnitarget.co/pricing" style="color:#9333ea;font-weight:500;text-decoration:none;">Buy More Credits →</a>
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
        Credits are valid for 12 months from purchase date. You're receiving this because you installed Omni Target on your Shopify store.
      </p>
      <p style="margin:0;">
        <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#888888;text-decoration:underline;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}
