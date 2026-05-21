import React from 'react';

interface LogoProps {
  className?: string;
}

export function Logo({ className = "w-8 h-8 text-[#a855f7]" }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      {/* Outer rings */}
      <circle cx="6.5" cy="17.5" r="3.5" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="17.5" cy="6.5" r="3.5" stroke="currentColor" strokeWidth="2.5" />
      
      {/* Inner dots */}
      <circle cx="6.5" cy="17.5" r="1.5" fill="currentColor" />
      <circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" />
      
      {/* Curved connecting line bowing towards bottom-right */}
      <path d="M 9 15 Q 15 15 15 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
