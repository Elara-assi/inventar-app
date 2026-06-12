"use client";

import { useEffect, useState } from "react";

/** Registriert den Service Worker und zeigt einen Hinweis, wenn eine neue
 *  Version bereitsteht (kontrollierte Updates statt Stale-Cache-Chaos). */
export function ServiceWorkerRegister() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          const incoming = registration.installing;
          incoming?.addEventListener("statechange", () => {
            if (incoming.state === "installed" && navigator.serviceWorker.controller) {
              setUpdateReady(true);
            }
          });
        });
      })
      .catch(() => {
        /* SW optional: App funktioniert auch ohne (dann eben nur online) */
      });
  }, []);

  if (!updateReady) return null;
  return (
    <div className="sw-update-banner">
      <span>Neue Version verfuegbar.</span>
      <button className="btn accent" onClick={() => window.location.reload()}>Neu laden</button>
    </div>
  );
}
