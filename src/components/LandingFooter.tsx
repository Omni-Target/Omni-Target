import Link from "next/link";

export function LandingFooter() {
  return (
    <footer className="bg-surface border-t border-border-subtle py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-6 h-6 rounded bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                <div className="w-3 h-3 bg-white rounded-sm rotate-45" />
              </div>
              <span className="font-bold text-lg">OmniTarget</span>
            </div>
            <p className="text-sm text-foreground/50 max-w-xs">
              Know exactly what to run on Meta. Before you spend. 
              The ultimate media buying co-pilot for Shopify brands.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-4 text-sm uppercase tracking-wider text-foreground/30">Product</h4>
            <ul className="space-y-2 text-sm text-foreground/60">
              <li><a href="#features" className="hover:text-primary transition-colors">Features</a></li>
              <li><a href="#pricing" className="hover:text-primary transition-colors">Pricing</a></li>
              <li><Link href="/login" className="hover:text-primary transition-colors">Login</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4 text-sm uppercase tracking-wider text-foreground/30">Legal</h4>
            <ul className="space-y-2 text-sm text-foreground/60">
              <li><Link href="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link></li>
              <li><Link href="/terms" className="hover:text-primary transition-colors">Terms of Service</Link></li>
            </ul>
          </div>
        </div>
        <div className="mt-12 pt-8 border-t border-border/10 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-xs text-foreground/40">
            © {new Date().getFullYear()} OmniTarget. All rights reserved.
          </p>
          <div className="flex gap-6 text-xs text-foreground/40">
            <span>Built for the next generation of Shopify entrepreneurs.</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
