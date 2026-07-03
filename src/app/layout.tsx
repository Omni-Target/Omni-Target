import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { MotionConfig } from "motion/react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Resolves the relative asset URLs below to absolute ones for crawlers,
  // anchored to wherever this deployment is actually served.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://app.omnitarget.co"),
  title: "Omni Target | Launch Profitable Meta Ads",
  description:
    "Omni Target helps Shopify merchants launch highly profitable Meta Ads by auditing accounts and installing the Meta Pixel.",
  icons: {
    icon: "/omni_target_logo.png",
    shortcut: "/omni_target_logo.png",
    apple: "/omni_target_logo.png",
  },
  openGraph: {
    title: "Omni Target | Launch Profitable Meta Ads",
    description: "Omni Target helps Shopify merchants launch highly profitable Meta Ads by auditing accounts and installing the Meta Pixel.",
    url: "https://omnitarget.co",
    siteName: "Omni Target",
    images: [
      {
        url: "/omni_target_logo.png",
        width: 100,
        height: 100,
        alt: "Omni Target Logo",
      },
    ],
    type: "website",
  },
  twitter: {
    // The brand mark is a small square — "summary" renders it as a compact
    // thumbnail instead of stretching it into a large banner.
    card: "summary",
    title: "Omni Target | Launch Profitable Meta Ads",
    description: "Omni Target helps Shopify merchants launch highly profitable Meta Ads by auditing accounts and installing the Meta Pixel.",
    images: ["/omni_target_logo.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col bg-background text-foreground antialiased">
          {/* Respect the OS "reduce motion" setting across every motion component.
              `user` keeps opacity fades but disables transform/layout animation. */}
          <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </body>
      </html>
    </ClerkProvider>
  );
}
