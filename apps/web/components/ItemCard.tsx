import { StatusBadge } from "./StatusBadge";

type Item = {
  id: string;
  inventory_id?: string;
  temporary_id?: string;
  object_type?: string;
  object_class_name?: string;
  brand?: string;
  model?: string;
  condition?: string;
  review_status?: string;
  confidence_score?: number;
  has_object_photo?: boolean;
  has_nameplate_photo?: boolean;
  has_dot_photo?: boolean;
};

export function ItemCard({ item }: { item: Item }) {
  return (
    <article className="card">
      <div className="photo-placeholder">{item.has_object_photo ? "Foto vorhanden" : "Foto fehlt"}</div>
      <div className="card-body grid">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <strong>{item.object_type || "Neues Objekt"}</strong>
          <StatusBadge value={item.review_status} />
        </div>
        <div className="muted">{item.inventory_id || item.temporary_id}</div>
        <div>{[item.brand, item.model].filter(Boolean).join(" ") || item.object_class_name || "KI wartet"}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="status erfasst">{item.condition || "gebraucht"}</span>
          {item.has_nameplate_photo ? <span className="status geprueft">Typenschild</span> : null}
          {item.has_dot_photo ? <span className="status geprueft">DOT</span> : null}
        </div>
      </div>
    </article>
  );
}
