import { Capacitor } from "@capacitor/core";
import { context } from "./types";

const base = import.meta.env.VITE_API_BASE_URL || "/api";
let nativeToken: string | null = null;
let accountId: string | null = null;
let sessionVersion = 0;
let installationKey: string | null = null;

export function setToken(token: string | null, userId: string | null = null) {
  nativeToken = token;
  accountId = userId;
  sessionVersion += 1;
}

function clientKey() {
  if (installationKey) return installationKey;
  try {
    const saved = localStorage.getItem("mewmo:installation");
    if (saved && /^[0-9a-f]{64}$/.test(saved)) installationKey = saved;
  } catch {
    /* Storage may be disabled; retain the key for this page lifetime. */
  }
  if (!installationKey) {
    installationKey = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    try {
      localStorage.setItem("mewmo:installation", installationKey);
    } catch {
      /* No account data or session tokens are persisted here. */
    }
  }
  return installationKey;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const version = sessionVersion;
  if (Capacitor.isNativePlatform() && !base.startsWith("https://")) {
    throw new Error(
      "Set VITE_API_BASE_URL to your Mewmo HTTPS API and rebuild the iPhone app.",
    );
  }
  const headers = new Headers(options.headers);
  const local = context();
  headers.set("X-Client-Date", local.local_date);
  headers.set("X-Client-Timezone", local.timezone);
  headers.set("X-Client-Key", clientKey());
  if (accountId) headers.set("X-Account-ID", accountId);
  if (options.body && !(options.body instanceof Blob))
    headers.set("Content-Type", "application/json");
  if (nativeToken) headers.set("Authorization", `Bearer ${nativeToken}`);
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  if (version !== sessionVersion)
    throw new Error("Account changed. Request discarded.");
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ detail: `Request failed (${response.status})` }));
    const detail = Array.isArray(body.detail)
      ? body.detail.map((e: { msg: string }) => e.msg).join(". ")
      : body.detail;
    if (version !== sessionVersion)
      throw new Error("Account changed. Request discarded.");
    if (
      response.status === 401 &&
      !["/auth/login", "/auth/register"].includes(path)
    )
      window.dispatchEvent(new Event("mewmo:unauthorized"));
    throw new Error(detail || "Something went wrong. Please try again.");
  }
  const result =
    response.status === 204 ? (undefined as T) : await response.json();
  if (version !== sessionVersion)
    throw new Error("Account changed. Request discarded.");
  return result;
}
