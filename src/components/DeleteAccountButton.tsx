"use client";

import * as React from "react";
import { useClerk } from "@clerk/nextjs";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function DeleteAccountButton() {
  const [open, setOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const { signOut } = useClerk();
  const confirmed = text.trim().toUpperCase() === "DELETE";

  const handleDelete = async () => {
    if (!confirmed) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/user/delete-account", { method: "DELETE" });
      if (res.ok) {
        // Sign out through Clerk to clear local tokens; redirects automatically.
        await signOut();
      } else {
        setError("Failed to delete account. Please try again.");
        setDeleting(false);
      }
    } catch {
      setError("An unexpected error occurred. Please try again.");
      setDeleting(false);
    }
  };

  return (
    <>
      <Button variant="danger-soft" onClick={() => setOpen(true)}>
        Delete account
      </Button>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (deleting) return;
          setOpen(v);
          if (!v) {
            setText("");
            setError(null);
          }
        }}
        title="Delete your account"
        description="This permanently deletes your account, all your campaign briefs, and disconnects your Shopify store. This action cannot be undone."
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setText("");
                setError(null);
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={!confirmed}
              isLoading={deleting}
            >
              Delete account
            </Button>
          </>
        }
      >
        <div className="rounded-xl border border-danger-100 bg-danger-50 p-4">
          <label
            htmlFor="delete-confirm"
            className="mb-2 block text-xs font-semibold uppercase tracking-wide text-danger-700"
          >
            Type &ldquo;DELETE&rdquo; to confirm
          </label>
          <Input
            id="delete-confirm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="DELETE"
            autoComplete="off"
            invalid={text.length > 0 && !confirmed}
          />
          {error && <p className="mt-2 text-xs font-medium text-danger-600">{error}</p>}
        </div>
      </Dialog>
    </>
  );
}
