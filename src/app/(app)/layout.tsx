import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";

export default async function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Defense-in-depth: `proxy.ts` already redirects unauthenticated requests, but
  // the Next.js docs warn proxy matchers can silently miss routes/Server
  // Functions, so the protected segment verifies the session itself too.
  const { userId } = await auth();
  if (!userId) {
    redirect("/login");
  }

  return <AppShell>{children}</AppShell>;
}
