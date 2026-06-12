export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN_KEY = "inventar.access_token";

export type Bootstrap = {
  users: Array<{ id: string; email: string; display_name: string; roles?: string[] }>;
  locations: Array<{ id: string; name: string; code: string }>;
  buildings: Array<{ id: string; name: string; location_id: string }>;
  rooms: Array<{ id: string; name: string; building_id: string; code?: string; room_type?: string }>;
  object_classes: Array<{ id: string; name: string; slug: string }>;
  brands?: string[];
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

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiResponse(path: string, init?: RequestInit): Promise<Response> {
  const isFormData = init?.body instanceof FormData;
  const token = getAuthToken();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new Error("Server nicht erreichbar. Bitte Verbindung prüfen und erneut versuchen.");
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text || `API error ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      const detail = parsed?.detail;
      if (typeof detail === "string") message = detail;
      if (detail?.message) message = detail.message;
    } catch {
      // Keep the raw response text when the API did not return JSON.
    }
    if (response.status === 401 && !path.startsWith("/auth/login")) {
      clearAuthToken();
      message = "Anmeldung abgelaufen. Bitte neu anmelden.";
    }
    throw new ApiError(message, response.status);
  }
  return response;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiResponse(path, init);
  return response.json() as Promise<T>;
}

function filenameFromDisposition(value: string | null) {
  if (!value) return "";
  const utfMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) return decodeURIComponent(utfMatch[1].replace(/"/g, ""));
  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ?? "";
}

export async function apiObjectUrl(path: string): Promise<string> {
  const response = await apiResponse(path);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export async function downloadApiFile(path: string, fallbackName = "download"): Promise<void> {
  const response = await apiResponse(path);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameFromDisposition(response.headers.get("content-disposition")) || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function joinUrl(token: string) {
  if (typeof window === "undefined") return `/mobile/join/${token}`;
  return `${window.location.origin}/mobile/join/${token}`;
}
