import * as React from 'react';

export const CreditLowEmail: React.FC = () => {
  return (
    <div style={{ backgroundColor: '#0f0f0f', color: '#ffffff', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', padding: '40px 20px', lineHeight: '1.5' }}>
      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ fontSize: '24px', fontWeight: 'bold', letterSpacing: '-0.5px', marginBottom: '40px' }}>
          OMNI TARGET
        </div>
        
        <p style={{ margin: '0 0 16px 0', fontSize: '16px', color: '#e5e5e5' }}>
          Heads up — you're down to your last brief credit.
        </p>
        
        <p style={{ margin: '0 0 24px 0', fontSize: '16px', color: '#e5e5e5' }}>
          Credits are valid for 12 months from purchase date. When you're ready to top up, we're here.
        </p>
        
        <a href="https://app.omnitarget.co/dashboard" style={{ backgroundColor: '#9333ea', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontWeight: '500', display: 'inline-block', marginBottom: '24px' }}>
          Top Up Credits →
        </a>

        <p style={{ margin: '0 0 40px 0', fontSize: '16px', color: '#e5e5e5' }}>
          — The Omni Target Team
        </p>
        
        <div style={{ borderTop: '1px solid #333333', paddingTop: '24px', fontSize: '14px', color: '#888888' }}>
          <p style={{ margin: '0 0 8px 0' }}>
            Credits are valid for 12 months from purchase date.
          </p>
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

export default CreditLowEmail;
