export function StatusBadge({ value }: { value?: string | null }) {
  const status = value || "erfasst";
  const labels: Record<string, string> = {
    erfasst: "Erfasst",
    ki_schnell_wartet: "Schnell-KI wartet",
    ki_schnell_laeuft: "Schnell-KI läuft",
    ki_schnell_fertig: "Schnell-KI fertig",
    ki_pruefung_offen: "Prüf-KI offen",
    ki_pruefung_wartet: "Prüf-KI wartet",
    ki_pruefung_laeuft: "Prüf-KI läuft",
    ki_pruefung_fertig: "Prüf-KI fertig",
    ki_vorgefuellt: "KI vorgefüllt",
    nacharbeit_erfasser: "Noch zu ergänzen",
    nacharbeit_pruefer: "Noch zu ergänzen",
    nacharbeit_buchhaltung: "Später auswerten",
    nacharbeit_technik: "Noch zu ergänzen",
    pruefen: "Noch zu ergänzen",
    finalisierbar: "Finalisierbar",
    geprueft: "Geprüft",
    finalisiert: "Finalisiert",
    abweichung: "Abweichung",
    dublette: "Dublette",
  };
  return <span className={`status ${status}`}>{labels[status] ?? status.replaceAll("_", " ")}</span>;
}
