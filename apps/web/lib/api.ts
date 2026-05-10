export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN_KEY = "inventar.access_token";

export type Bootstrap = {
  users: Array<{ id: string; email: string; display_name: string; roles?: string[] }>;
  locations: Array<{ id: string; name: string; code: string }>;
  buildings: Array<{ id: string; name: string; location_id: string }>;
  rooms: Array<{ id: string; name: string; building_id: string; code?: string; room_type?: string }>;
  object_classes: Array<{ id: string; name: string; slug: string }>;
};

export type InventoryType = "bga" | "tires_wheels" | "special_tools";

export const inventoryTypeLabels: Record<InventoryType, string> = {
  bga: "Betriebs- und Geschäftsausstattung",
  tires_wheels: "Reifen und Räder",
  special_tools: "Spezialwerkzeuge",
};

export function inventoryTypeLabel(value?: string | null) {
  return inventoryTypeLabels[(value || "bga") as InventoryType] ?? inventoryTypeLabels.bga;
}

export type ItemTemplate = {
  id: string;
  source: string;
  label: string;
  subtitle?: string | null;
  object_type?: string | null;
  object_class_id?: string | null;
  object_class_slug?: string | null;
  brand?: string | null;
  model?: string | null;
};

export function getAuthToken() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_KEY) || "";
}

export function setAuthToken(token: string) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export function clearAuthToken() {
  setAuthToken("");
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const token = getAuthToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      const detail = parsed?.detail;
      if (typeof detail === "string") throw new Error(detail);
      if (detail?.message) throw new Error(detail.message);
    } catch (err) {
      if (err instanceof Error && err.name === "Error") throw err;
    }
    throw new Error(text || `API error ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function joinUrl(token: string) {
  if (typeof window === "undefined") return `/mobile/join/${token}`;
  return `${window.location.origin}/mobile/join/${token}`;
}
