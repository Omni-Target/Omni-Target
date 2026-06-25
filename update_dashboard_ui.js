const fs = require('fs');
let code = fs.readFileSync('src/app/dashboard/page.tsx', 'utf8');

const anchor = `        {!loading && connected && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 animate-fade-in-up">`;

const prompt = `        {!loading && connected && needsReauth && (
          <div className="bg-brand-500/10 border border-brand-500/20 text-brand-300 rounded-xl p-4 mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 animate-fade-in-up">
            <div>
              <h3 className="text-sm font-semibold mb-1 text-brand-300">Unlock Full Order History</h3>
              <p className="text-xs text-brand-300/70">Full order history gives you more accurate recommendations. We recently updated our permissions.</p>
            </div>
            <Link
              href="/api/auth/shopify/connect?from=dashboard"
              className="bg-brand-500/20 hover:bg-brand-500/30 border border-brand-500/20 text-brand-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
            >
              Reconnect Store
            </Link>
          </div>
        )}

        {!loading && connected && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 animate-fade-in-up">`;

code = code.replace(anchor, prompt);
fs.writeFileSync('src/app/dashboard/page.tsx', code);
console.log('Updated UI in dashboard');
