import Link from "next/link";

export default function ReviewRedirect() {
  return (
    <main className="page panel grid">
      <h1>Prüfer-Dashboard</h1>
      <p className="muted">Waehle eine aktive Session auf dem Dashboard.</p>
      <Link className="btn accent" href="/">Dashboard öffnen</Link>
    </main>
  );
}
