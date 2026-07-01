import Link from "next/link";
import { Compass } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";

/**
 * App-wide 404. Rendered within the root layout, so the design system and
 * global styles are available.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <Logo className="size-9 text-brand-600" />
      <div className="flex size-14 items-center justify-center rounded-2xl border border-border-subtle bg-surface-subtle text-subtle-foreground">
        <Compass className="size-6" />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-semibold tracking-wide text-brand-600">404</p>
        <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
        <Button variant="secondary" asChild>
          <Link href="/">Back to home</Link>
        </Button>
      </div>
    </main>
  );
}
