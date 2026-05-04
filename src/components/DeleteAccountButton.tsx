"use client";

import { useState } from "react";

export function DeleteAccountButton() {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== "DELETE") return;

    setDeleting(true);
    try {
      const res = await fetch("/api/user/delete-account", {
        method: "DELETE",
      });

      if (res.ok) {
        // Redirect to login after deletion
        window.location.href = "/login";
      } else {
        alert("Failed to delete account. Please try again.");
        setDeleting(false);
      }
    } catch {
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setShowDeleteModal(true)}
        className="text-sm text-error-400 hover:text-error-300 transition-colors border border-error-500/20 hover:border-error-500/40 px-4 py-2 rounded-lg"
      >
        Delete Account
      </button>

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-surface-raised border border-border-subtle rounded-2xl p-6 max-w-md w-full shadow-2xl animate-fade-in-up">
            <h3 className="text-xl font-semibold text-white mb-2">Delete your account</h3>
            <p className="text-sm text-white/50 mb-6">
              This will permanently delete your account, all your campaign briefs, and disconnect your Shopify store. This cannot be undone.
            </p>
            
            <div className="mb-6">
              <label className="block text-xs font-medium text-white/40 mb-2">
                Type DELETE to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="Type DELETE to confirm"
                className="w-full bg-black/20 border border-border-subtle rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-error-500/50 focus:border-error-500"
              />
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-medium text-white/70 hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleteConfirmText !== "DELETE" || deleting}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-error-500 hover:bg-error-400 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? "Deleting..." : "Delete My Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
