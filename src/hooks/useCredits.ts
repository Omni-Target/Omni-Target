"use client";
import { useState, useEffect } from "react";

export function useCredits() {
  const [credits, setCredits] = useState<number | null>(null);
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [unlimitedUntil, setUnlimitedUntil] = useState<Date | null>(null);

  useEffect(() => {
    fetch("/api/user/credits")
      .then(r => r.json())
      .then(data => {
        setCredits(data.credits_balance || 0);
        setIsUnlimited(data.is_unlimited);
        if (data.unlimited_until) {
          setUnlimitedUntil(new Date(data.unlimited_until));
        }
      })
      .catch(() => {});
  }, []);

  return { credits, isUnlimited, unlimitedUntil };
}
