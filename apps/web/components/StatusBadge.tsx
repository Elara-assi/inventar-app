export function StatusBadge({ value }: { value?: string | null }) {
  const status = value || "erfasst";
  const labels: Record<string, string> = {
    erfasst: "Erfasst",
    ki_vorgefuellt: "KI vorgefüllt",
    nacharbeit_erfasser: "Noch zu ergänzen",
    nacharbeit_pruefer: "Noch zu ergänzen",
    nacharbeit_buchhaltung: "Noch zu ergänzen",
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
