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
      <body>
        <div className="shell">
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
