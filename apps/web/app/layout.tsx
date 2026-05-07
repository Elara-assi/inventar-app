import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inventar Maschine",
  description: "KI-gestützte Inventur für mehrere Standorte",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
              <span className="status ki_vorgefuellt">Phase 1</span>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
