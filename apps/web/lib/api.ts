export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Bootstrap = {
  locations: Array<{ id: string; name: string; code: string }>;
  buildings: Array<{ id: string; name: string; location_id: string }>;
  rooms: Array<{ id: string; name: string; building_id: string }>;
  object_classes: Array<{ id: string; name: string; slug: string }>;
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `API error ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function joinUrl(token: string) {
  if (typeof window === "undefined") return `/mobile/join/${token}`;
  return `${window.location.origin}/mobile/join/${token}`;
}
