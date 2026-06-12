export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Bootstrap = {
  locations: Array<{ id: string; name: string; code: string }>;
  buildings: Array<{ id: string; name: string; location_id: string }>;
  rooms: Array<{ id: string; name: string; building_id: string }>;
  object_classes: Array<{ id: string; name: string; slug: string }>;
};

export type FieldRequirement = {
  id: string;
  field_name: string;
  field_label: string;
  required: boolean;
  blocks_finalization: boolean;
  evidence_photo_type: string | null;
  responsible_role: string;
  sort_order: number;
};

/** FastAPI-Fehlerdetails (String oder strukturiert) in lesbaren Text wandeln. */
function readableError(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw);
    const detail = parsed?.detail ?? parsed;
    if (typeof detail === "string") return detail;
    if (detail?.message) {
      if (detail.blockers && typeof detail.blockers === "object") {
        const parts = Object.entries(detail.blockers)
          .map(([key, value]) => `${key}: ${(value as string[]).join(", ")}`)
          .join(" | ");
        return `${detail.message} – ${parts}`;
      }
      return detail.message;
    }
    if (Array.isArray(detail)) {
      return detail.map((entry) => entry?.msg ?? JSON.stringify(entry)).join("; ");
    }
    return raw;
  } catch {
    return raw || `API-Fehler ${status}`;
  }
}

export async function api<T>(path: string, init?: RequestInit, timeoutMs = 20000): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(readableError(text, response.status));
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Zeitueberschreitung – Netzwerk pruefen");
    }
    if (err instanceof TypeError) {
      throw new Error("API nicht erreichbar – Netzwerk pruefen");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Upload mit automatischem Retry (Netz-Wackler in Werkstatt/Lager). */
export async function apiWithRetry<T>(path: string, init: RequestInit, retries = 3): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await api<T>(path, init, 30000);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : "";
      // Fachliche Fehler (Validierung, Konflikt) nicht wiederholen.
      if (!/Netzwerk|Zeitueberschreitung|API-Fehler 5/.test(message)) throw err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Upload fehlgeschlagen");
}

export function photoUrl(photoId: string, variant: "original" | "stamped" = "original") {
  return `${API_BASE}/files/photo/${photoId}?variant=${variant}`;
}

export function joinUrl(token: string) {
  if (typeof window === "undefined") return `/mobile/join/${token}`;
  return `${window.location.origin}/mobile/join/${token}`;
}
