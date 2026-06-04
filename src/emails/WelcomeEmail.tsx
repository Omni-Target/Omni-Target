import * as React from 'react';

interface WelcomeEmailProps {
  name: string;
}

export const WelcomeEmail: React.FC<WelcomeEmailProps> = ({ name }) => (
  <div style={{ fontFamily: 'Arial, sans-serif', color: '#333', padding: '20px' }}>
    <h1 style={{ color: '#000', fontSize: '24px', margin: '0 0 20px 0' }}>Welcome to OmniTarget!</h1>
    <p style={{ margin: '0 0 16px 0' }}>Hi {name},</p>
    <p style={{ margin: '0 0 16px 0' }}>
      We're excited to have you on board. Let's get started with your first campaign!
    </p>
    <div style={{ marginTop: '30px' }}>
      <a 
        href="https://app.omnitarget.co" 
        style={{ 
          backgroundColor: '#000', 
          color: '#fff', 
          padding: '12px 24px', 
          textDecoration: 'none', 
          borderRadius: '4px',
          display: 'inline-block'
        }}
      >
        Go to Dashboard
      </a>
    </div>
  </div>
);

export default WelcomeEmail;
