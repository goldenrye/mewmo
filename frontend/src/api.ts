import { Capacitor } from "@capacitor/core";
import { context } from "./types";

const base = import.meta.env.VITE_API_BASE_URL || "/api";
let nativeToken: string | null = null;

export function setToken(token: string | null) {
  nativeToken = token;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (Capacitor.isNativePlatform() && !base.startsWith("https://")) {
    throw new Error(
      "Set VITE_API_BASE_URL to your Mewmo HTTPS API and rebuild the iPhone app.",
    );
  }
  const headers = new Headers(options.headers);
  const local = context();
  headers.set("X-Client-Date", local.local_date);
  headers.set("X-Client-Timezone", local.timezone);
  if (options.body && !(options.body instanceof Blob))
    headers.set("Content-Type", "application/json");
  if (nativeToken) headers.set("Authorization", `Bearer ${nativeToken}`);
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ detail: `Request failed (${response.status})` }));
    const detail = Array.isArray(body.detail)
      ? body.detail.map((e: { msg: string }) => e.msg).join(". ")
      : body.detail;
    if (response.status === 401 && path !== "/auth/login")
      window.dispatchEvent(new Event("mewmo:unauthorized"));
    throw new Error(detail || "Something went wrong. Please try again.");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
