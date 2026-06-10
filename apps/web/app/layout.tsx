import type { Metadata } from "next";
import "./globals.css";
import webPackage from "../package.json";

export const metadata: Metadata = {
  title: "Inventar Maschine",
  description: "KI-gestützte Inventur für mehrere Standorte",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || webPackage.version;
  const releaseId = process.env.NEXT_PUBLIC_RELEASE_ID || "local";
  const deployEnv = process.env.NEXT_PUBLIC_DEPLOY_ENV || process.env.NODE_ENV || "unknown";
  const versionLabel = `Version ${appVersion}`;
  const buildLabel = `Build ${appVersion} / ${releaseId} / ${deployEnv}`;

  return (
    <html lang="de">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>
        <div className="shell app-shell">
          <aside className="app-rail" aria-label="App Navigation">
            <a className="rail-logo" href="/" aria-label="Inventar Dashboard">▣</a>
            <nav className="rail-nav" aria-label="Hauptbereiche">
              <a className="is-active" href="/" aria-label="Dashboard">⌂</a>
              <a href="/review" aria-label="Prüfung">▤</a>
              <a href="/design-preview" aria-label="Design">◇</a>
              <a href="/design-preview-premium" aria-label="Premium Design">▥</a>
            </nav>
            <div className="rail-bottom" aria-hidden="true">◌</div>
          </aside>
          <header className="topbar">
            <div className="topbar-inner">
              <div className="brand">
                Inventar Maschine
                <span>Mit dem Handy die Objekte schnell erfassen, mit dem Laptop/iPad bequem nacharbeiten.</span>
              </div>
              <div className="topbar-badges" aria-label="Build status">
                <span className="status ki_vorgefuellt">Phase 1</span>
                <span className="status version_badge">{versionLabel}</span>
              </div>
            </div>
            <div className="build-strip">{buildLabel}</div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
