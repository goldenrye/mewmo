import { Capacitor, registerPlugin } from "@capacitor/core";
import { api, apiBase, ApiError, currentSession, setToken } from "./api";
import type { Account, AuthResult } from "./types";
import { getLocale } from "./i18n";

export type BiometricStatus = {
  available: boolean;
  enabled: boolean;
  label: "Face ID" | "Touch ID";
};
export type BiometricLoginStage = "unlocking" | "verifying";

export class BiometricPasswordRequiredError extends Error {
  constructor(
    message: string,
    public readonly reason: "missing" | "invalid" | "rejected" = "rejected",
  ) {
    super(message);
  }
}

export class BiometricConnectionError extends Error {}

const verificationTimeout =
  "Session verification timed out. Check your connection, then try again or use your password.";

interface BiometricBridge {
  status(options: { server: string }): Promise<BiometricStatus>;
  store(options: {
    server: string;
    token: string;
    userId: string;
    language: string;
  }): Promise<void>;
  restore(options: {
    server: string;
    language: string;
  }): Promise<{ token: string; userId: string }>;
  clear(options: { server: string }): Promise<void>;
}

const bridge = registerPlugin<BiometricBridge>("MewmoBiometrics");
const unsupported: BiometricStatus = {
  available: false,
  enabled: false,
  label: "Face ID",
};
let mutations: Promise<unknown> = Promise.resolve();

export function supportsBiometrics() {
  return (
    Capacitor.getPlatform() === "ios" &&
    Capacitor.isPluginAvailable("MewmoBiometrics")
  );
}

// Finish a pending opt-in before clearing it or saving a different account.
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutations.catch(() => {}).then(operation);
  mutations = result;
  return result;
}

export async function biometricStatus(): Promise<BiometricStatus> {
  if (!supportsBiometrics()) return unsupported;
  await mutations.catch(() => {});
  return bridge.status({ server: apiBase });
}

export async function clearBiometrics(): Promise<void> {
  if (!supportsBiometrics()) return;
  return serialize(() => bridge.clear({ server: apiBase }));
}

export async function enableBiometrics(): Promise<void> {
  const session = currentSession();
  if (!supportsBiometrics() || !session.token || !session.userId)
    throw new Error("Sign in with your password in the iPhone app first.");
  return serialize(async () => {
    if (currentSession().version !== session.version)
      throw new Error("Account changed. Please try again.");
    await bridge.store({
      server: apiBase,
      token: session.token!,
      userId: session.userId!,
      language: getLocale(),
    });
    if (currentSession().version !== session.version) {
      await bridge.clear({ server: apiBase });
      throw new Error("Account changed. Biometric setup was cancelled.");
    }
  });
}

export async function signInWithBiometrics(
  onProgress?: (stage: BiometricLoginStage) => void,
): Promise<AuthResult> {
  if (!supportsBiometrics())
    throw new Error("Use your password to sign in on this device.");
  const version = currentSession().version;
  onProgress?.("unlocking");
  await mutations.catch(() => {});
  let saved: { token: string; userId: string };
  try {
    saved = await bridge.restore({
      server: apiBase,
      language: getLocale(),
    });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (currentSession().version !== version)
      throw new Error("Account changed. Sign-in cancelled.");
    if (code === "MISSING_SESSION" || code === "INVALID_SESSION")
      throw new BiometricPasswordRequiredError(
        code === "MISSING_SESSION"
          ? "No saved sign-in was found on this iPhone. Sign in with your password."
          : "The saved sign-in on this iPhone cannot be read or is invalid. Sign in with your password.",
        code === "MISSING_SESSION" ? "missing" : "invalid",
      );
    throw error;
  }
  if (currentSession().version !== version)
    throw new Error("Account changed. Sign-in cancelled.");
  if (!saved.token || !saved.userId)
    throw new BiometricPasswordRequiredError(
      "The saved sign-in on this iPhone cannot be read or is invalid. Sign in with your password.",
      "invalid",
    );
  setToken(saved.token, saved.userId);
  const restoredVersion = currentSession().version;
  let mismatchedAccount = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A successful local scan is not enough: the server must accept the session.
    onProgress?.("verifying");
    // Race as well as abort: a stalled WebView request must not trap the login UI.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new BiometricConnectionError(verificationTimeout));
        controller.abort();
      }, 10_000);
    });
    const account = await Promise.race([
      api<Account>("/auth/me", {
        signal: controller.signal,
        cache: "no-store",
      }),
      deadline,
    ]);
    if (currentSession().version !== restoredVersion)
      throw new Error("Account changed. Sign-in cancelled.");
    if (account.user.id !== saved.userId) {
      mismatchedAccount = true;
      throw new Error("Account changed. Please sign in with your password.");
    }
    return { ...account, token: saved.token };
  } catch (error) {
    const sameSession = currentSession().version === restoredVersion;
    if (sameSession) setToken(null);
    if (
      mismatchedAccount ||
      (error instanceof ApiError && error.status === 401)
    ) {
      await clearBiometrics();
      throw new BiometricPasswordRequiredError(
        mismatchedAccount
          ? "The saved sign-in does not match the server account. Sign in with your password."
          : "The server rejected your saved session. It may be expired or revoked. Sign in with your password.",
        mismatchedAccount ? "invalid" : "rejected",
      );
    }
    if (sameSession && error instanceof TypeError)
      throw new BiometricConnectionError(
        "Could not reach the server to verify your saved sign-in. Check your connection and retry.",
      );
    if (
      sameSession &&
      error instanceof ApiError &&
      (error.status >= 500 || error.status === 429)
    )
      throw new BiometricConnectionError(
        "The server is temporarily unable to verify your saved sign-in. Please retry later.",
      );
    // Connectivity failures leave the protected Keychain session available for retry.
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
