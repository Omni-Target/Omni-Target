"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";

export function DeleteAccountButton() {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const { signOut } = useClerk();

  const handleDeleteAccount = async () => {
    if (deleteConfirmText.toUpperCase() !== "DELETE") return;

    setDeleting(true);
    try {
      const res = await fetch("/api/user/delete-account", {
        method: "DELETE",
      });

      if (res.ok) {
        // Sign out through Clerk to clear all local tokens safely
        // This will automatically redirect to the root/login page
        await signOut();
      } else {
        alert("Failed to delete account. Please try again.");
        setDeleting(false);
      }
    } catch {
      alert("An unexpected error occurred. Please try again.");
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setShowDeleteModal(true)}
        className="text-sm font-medium text-error-400 hover:text-error-300 transition-colors border border-error-500/20 hover:border-error-500/40 px-4 py-2 rounded-xl bg-error-500/5 hover:bg-error-500/10 cursor-pointer"
      >
        Delete Account
      </button>

      {showDeleteModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-surface border border-border-subtle rounded-2xl p-6 max-w-md w-full shadow-2xl animate-fade-in-up">
            <h3 className="text-xl font-bold text-white mb-2">Delete your account</h3>
            <p className="text-sm text-white/60 mb-6 leading-relaxed">
              This will permanently delete your account, all your campaign briefs, and disconnect your Shopify store. This action cannot be undone.
            </p>
            
            <div className="mb-6 bg-error-500/5 border border-error-500/20 p-4 rounded-xl">
              <label className="block text-xs font-semibold text-error-400 uppercase tracking-wider mb-2">
                Type "DELETE" to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                className="w-full bg-black/40 border border-error-500/30 rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-error-500/50"
              />
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmText("");
                }}
                disabled={deleting}
                className="px-4 py-2.5 rounded-xl text-sm font-medium text-white/70 hover:bg-white/10 transition-colors disabled:opacity-50 cursor-pointer border-none bg-transparent"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleteConfirmText.toUpperCase() !== "DELETE" || deleting}
                className="px-4 py-2.5 rounded-xl text-sm font-medium bg-error-500 hover:bg-error-400 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[140px] cursor-pointer border-none"
              >
                {deleting ? "Deleting..." : "Delete Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
