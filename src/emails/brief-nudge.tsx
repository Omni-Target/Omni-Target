import * as React from 'react';

export const BriefNudgeEmail: React.FC = () => {
  return (
    <div style={{ backgroundColor: '#0f0f0f', color: '#ffffff', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', padding: '40px 20px', lineHeight: '1.5' }}>
      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ fontSize: '24px', fontWeight: 'bold', letterSpacing: '-0.5px', marginBottom: '40px' }}>
          OMNI TARGET
        </div>
        
        <p style={{ margin: '0 0 16px 0', fontSize: '16px', color: '#e5e5e5' }}>
          Your store data is sitting there ready.
        </p>
        
        <p style={{ margin: '0 0 16px 0', fontSize: '16px', color: '#e5e5e5' }}>
          We've identified your best products to advertise — Gateway Products that convert cold traffic into first-time buyers. You're one brief away from knowing exactly what to run, who to target, and how much to spend.
        </p>

        <p style={{ margin: '0 0 24px 0', fontSize: '16px', color: '#e5e5e5' }}>
          Your free credit doesn't expire. Use it when you're ready.
        </p>
        
        <a href="https://app.omnitarget.co/dashboard" style={{ backgroundColor: '#9333ea', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontWeight: '500', display: 'inline-block', marginBottom: '24px' }}>
          See Your Store Intelligence →
        </a>

        <p style={{ margin: '0 0 40px 0', fontSize: '16px', color: '#e5e5e5' }}>
          — The Omni Target Team
        </p>
        
        <div style={{ borderTop: '1px solid #333333', paddingTop: '24px', fontSize: '14px', color: '#888888' }}>
          <p style={{ margin: '0' }}>
            Omni Target · hello@app.omnitarget.co · You're receiving this because you installed Omni Target on your Shopify store
          </p>
          <p style={{ margin: '8px 0 0 0' }}>
            <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style={{ color: '#888888', textDecoration: 'underline' }}>Unsubscribe</a>
          </p>
        </div>
      </div>
    </div>
  );
};

export default BriefNudgeEmail;
