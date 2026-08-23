"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that makes the dashboard installable and gives
 * it an offline shell.
 *
 * Registration waits for `load` so it never competes with first paint, and is
 * skipped in development — a cached dev bundle is a debugging trap, not a
 * feature. The worker itself caches nothing private: it stays clear of the API
 * routes, so the chat and the writes always reach the network.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.error("Service worker registration failed:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
