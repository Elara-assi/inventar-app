import type { Metadata } from "next";
import "./globals.css";
import webPackage from "../package.json";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Inventar Maschine",
  description: "KI-gestuetzte Inventur fuer Autohaus-Standorte",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || webPackage.version;
  const releaseId = process.env.NEXT_PUBLIC_RELEASE_ID || "local";
  const deployEnv = process.env.NEXT_PUBLIC_DEPLOY_ENV || process.env.NODE_ENV || "unknown";
  const versionLabel = `Version ${appVersion}`;
  const buildLabel = `Build ${appVersion} • ${releaseId} • ${deployEnv}`;

  return (
    <html lang="de">
      <body>
        <ServiceWorkerRegister />
        <div className="shell">
          <header className="topbar">
            <div className="topbar-inner">
              <div className="brand">
                Inventar Maschine
                <span>Handy schnell erfassen. Pruefer entscheidet.</span>
              </div>
              <div className="topbar-badges">
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
