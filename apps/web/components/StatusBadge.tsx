export function StatusBadge({ value }: { value?: string | null }) {
  const label = value || "erfasst";
  return <span className={`status ${label}`}>{label.replaceAll("_", " ")}</span>;
}
