import type { Bootstrap } from "@/lib/api";

type JoinedSession = {
  session: {
    id: string;
    location_id: string;
    building_id: string;
    room_id: string;
    inventory_type?: string | null;
  };
  device: { id: string };
  access_token?: string;
};

export type MobileSessionCapsule = {
  token: string;
  joined: JoinedSession;
  bootstrap?: Bootstrap | null;
  objectClassId?: string;
  accessToken?: string;
  savedAt: string;
  expiresAt?: number | null;
};

const CAPSULE_PREFIX = "inventar.mobile_session_capsule.";

function storageKey(token: string) {
  return `${CAPSULE_PREFIX}${token}`;
}

function parseJwtExp(token?: string) {
  if (!token) return null;
  try {
    const [, payload] = token.split(".");
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

export function saveMobileSessionCapsule(input: {
  token: string;
  joined: JoinedSession;
  bootstrap?: Bootstrap | null;
  objectClassId?: string;
  accessToken?: string;
}) {
  if (typeof window === "undefined" || !input.token || !input.joined) return;
  const capsule: MobileSessionCapsule = {
    token: input.token,
    joined: input.joined,
    bootstrap: input.bootstrap ?? null,
    objectClassId: input.objectClassId,
    accessToken: input.accessToken ?? input.joined.access_token,
    savedAt: new Date().toISOString(),
    expiresAt: parseJwtExp(input.accessToken ?? input.joined.access_token),
  };
  window.localStorage.setItem(storageKey(input.token), JSON.stringify(capsule));
}

export function loadMobileSessionCapsule(token: string): MobileSessionCapsule | null {
  if (typeof window === "undefined" || !token) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(token));
    if (!raw) return null;
    const capsule = JSON.parse(raw) as MobileSessionCapsule;
    if (!capsule.joined?.session?.id) return null;
    return capsule;
  } catch {
    return null;
  }
}
