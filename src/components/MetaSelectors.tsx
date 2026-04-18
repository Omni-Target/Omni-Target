"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MetaSelectors({
  allAccounts,
  selectedAccountId,
  allPages,
  selectedPageId,
}: {
  allAccounts: any[];
  selectedAccountId: string | null;
  allPages: any[];
  selectedPageId: string | null;
}) {
  const router = useRouter();
  const [loadingAccount, setLoadingAccount] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  const handleAccountChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setLoadingAccount(true);
    try {
      const res = await fetch("/api/user/select-ad-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adAccountId: val }),
      });
      if (res.ok) {
        setSuccessMsg("Ad account updated");
        setTimeout(() => setSuccessMsg(""), 3000);
        router.refresh();
      }
    } catch(err) {
      console.error(err);
    } finally {
      setLoadingAccount(false);
    }
  };

  const handlePageChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    const selectedPage = allPages.find((p) => p.id === val);
    if (!selectedPage) return;

    setLoadingPage(true);
    try {
      const res = await fetch("/api/user/select-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          meta_page_id: selectedPage.id, 
          meta_page_name: selectedPage.name 
        }),
      });
      if (res.ok) {
        setSuccessMsg("Facebook Page updated");
        setTimeout(() => setSuccessMsg(""), 3000);
        router.refresh();
      }
    } catch(err) {
      console.error(err);
    } finally {
      setLoadingPage(false);
    }
  };

  // Filter to only show writable, active accounts
  const writableAccounts = allAccounts.filter(
    (a: any) =>
      a.account_status === 1 &&
      (!a.user_tasks || a.user_tasks.includes("ADVERTISE"))
  );

  return (
    <div className="flex flex-col gap-5 mt-4 w-full">
      {writableAccounts.length > 1 ? (
        <div>
          <label className="block text-xs font-medium text-white/50 mb-1.5">
            Active Ad Account
          </label>
          <select 
            value={selectedAccountId || ""} 
            onChange={handleAccountChange}
            disabled={loadingAccount}
            className="w-full sm:max-w-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/50 appearance-none disabled:opacity-50"
          >
            {writableAccounts.map((a) => (
              <option key={a.id} value={a.id} className="bg-gray-900 text-white">
                {a.name} ({a.currency || "USD"})
              </option>
            ))}
          </select>
        </div>
      ) : writableAccounts.length === 1 ? (
        <div>
          <label className="block text-xs font-medium text-white/50 mb-0.5">
            Active Ad Account
          </label>
          <p className="text-sm text-white">{writableAccounts[0].name} ({writableAccounts[0].currency || "USD"})</p>
        </div>
      ) : null}

      {allPages.length > 1 ? (
        <div>
          <label className="block text-xs font-medium text-white/50 mb-1.5">
            Active Facebook Page
          </label>
          <select 
            value={selectedPageId || ""} 
            onChange={handlePageChange}
            disabled={loadingPage}
            className="w-full sm:max-w-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/50 appearance-none disabled:opacity-50"
          >
            {allPages.map((p) => (
              <option key={p.id} value={p.id} className="bg-gray-900 text-white">
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ) : allPages.length === 1 ? (
        <div>
          <label className="block text-xs font-medium text-white/50 mb-0.5">
            Active Facebook Page
          </label>
          <p className="text-sm text-white">{allPages[0].name}</p>
        </div>
      ) : null}

      {successMsg && (
        <div className="text-xs font-medium text-green-400 animate-fade-in flex items-center gap-1.5">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
           {successMsg}
        </div>
      )}
    </div>
  );
}
