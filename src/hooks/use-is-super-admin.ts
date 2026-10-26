"use client";

import { useEffect, useState } from "react";

/** True when the signed-in user is the platform owner (SUPER_ADMIN_EMAILS). */
export function useIsSuperAdmin(): boolean {
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/session", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { isSuperAdmin: false }))
      .then((data) => {
        if (!cancelled) setIsSuperAdmin(Boolean(data?.isSuperAdmin));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return isSuperAdmin;
}
