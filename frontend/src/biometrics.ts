import { Capacitor, registerPlugin } from "@capacitor/core";
import { api, apiBase, ApiError, currentSession, setToken } from "./api";
import type { Account, AuthResult } from "./types";
import { getLocale } from "./i18n";

export type BiometricStatus = {
  available: boolean;
  enabled: boolean;
  label: "Face ID" | "Touch ID";
};

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

export async function signInWithBiometrics(): Promise<AuthResult> {
  if (!supportsBiometrics())
    throw new Error("Use your password to sign in on this device.");
  const version = currentSession().version;
  await mutations.catch(() => {});
  const saved = await bridge.restore({
    server: apiBase,
    language: getLocale(),
  });
  if (currentSession().version !== version)
    throw new Error("Account changed. Sign-in cancelled.");
  if (!saved.token || !saved.userId)
    throw new Error("The saved session is unavailable. Use your password.");
  setToken(saved.token, saved.userId);
  const restoredVersion = currentSession().version;
  let mismatchedAccount = false;
  try {
    // A successful local scan is not enough: the server must accept the session.
    const account = await api<Account>("/auth/me");
    if (account.user.id !== saved.userId) {
      mismatchedAccount = true;
      throw new Error("Account changed. Please sign in with your password.");
    }
    return { ...account, token: saved.token };
  } catch (error) {
    if (currentSession().version === restoredVersion) setToken(null);
    if (
      mismatchedAccount ||
      (error instanceof ApiError && error.status === 401)
    ) {
      await clearBiometrics();
      throw new Error(
        "Your session has expired or been revoked. Sign in with your password.",
      );
    }
    // Connectivity failures leave the protected Keychain session available for retry.
    throw error;
  }
}
