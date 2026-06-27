import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
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
  title: "Omni Target | Launch Profitable Meta Ads",
  description:
    "Omni Target helps Shopify merchants launch highly profitable Meta Ads by auditing accounts and installing the Meta Pixel.",
  icons: {
    icon: "https://res.cloudinary.com/denwiqjid/image/upload/v1779707457/omni_target_logo_ae2epf.png",
    shortcut: "https://res.cloudinary.com/denwiqjid/image/upload/v1779707457/omni_target_logo_ae2epf.png",
    apple: "https://res.cloudinary.com/denwiqjid/image/upload/v1779707457/omni_target_logo_ae2epf.png",
  },
  openGraph: {
    title: "Omni Target | Launch Profitable Meta Ads",
    description: "Omni Target helps Shopify merchants launch highly profitable Meta Ads by auditing accounts and installing the Meta Pixel.",
    url: "https://omnitarget.co",
    siteName: "Omni Target",
    images: [
      {
        url: "https://res.cloudinary.com/denwiqjid/image/upload/v1779707457/omni_target_logo_ae2epf.png",
        width: 800,
        height: 600,
        alt: "Omni Target Logo",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Omni Target | Launch Profitable Meta Ads",
    description: "Omni Target helps Shopify merchants launch highly profitable Meta Ads by auditing accounts and installing the Meta Pixel.",
    images: ["https://res.cloudinary.com/denwiqjid/image/upload/v1779707457/omni_target_logo_ae2epf.png"],
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
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
