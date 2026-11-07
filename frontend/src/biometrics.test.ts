import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => "ios"),
  pluginAvailable: vi.fn(() => true),
  status: vi.fn(),
  store: vi.fn(),
  restore: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: mocks.platform,
    isNativePlatform: () => mocks.platform() === "ios",
    isPluginAvailable: mocks.pluginAvailable,
  },
  registerPlugin: () => mocks,
}));

const server = "https://mewmo.example/api";
const user = {
  id: "alice-id",
  username: "alice",
  display_name: "Alice",
  is_admin: false,
};
let auth: typeof import("./api");
let biometric: typeof import("./biometrics");

beforeEach(async () => {
  vi.resetModules();
  mocks.platform.mockReturnValue("ios");
  mocks.pluginAvailable.mockReturnValue(true);
  mocks.status.mockResolvedValue({
    available: true,
    enabled: true,
    label: "Face ID",
  });
  mocks.store.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue({
    token: "protected-token",
    userId: user.id,
  });
  vi.stubEnv("VITE_API_BASE_URL", server);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem: vi.fn() });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ user, vapid_public_key: "" })),
  );
  auth = await import("./api");
  biometric = await import("./biometrics");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("does not expose or call native biometrics in a browser", async () => {
  mocks.platform.mockReturnValue("web");
  expect(await biometric.biometricStatus()).toMatchObject({
    available: false,
    enabled: false,
  });
  await expect(biometric.signInWithBiometrics()).rejects.toThrow(
    "Use your password",
  );
  expect(mocks.restore).not.toHaveBeenCalled();
  expect(mocks.status).not.toHaveBeenCalled();
  await biometric.clearBiometrics();
  expect(mocks.clear).not.toHaveBeenCalled();
});

it("keeps password sign-in usable in old iPhone builds without the plugin", async () => {
  mocks.pluginAvailable.mockReturnValue(false);
  expect(await biometric.biometricStatus()).toMatchObject({ enabled: false });
  await biometric.clearBiometrics();
  expect(mocks.clear).not.toHaveBeenCalled();
});

it("requires a signed-in account before saving anything", async () => {
  await expect(biometric.enableBiometrics()).rejects.toThrow(
    "Sign in with your password",
  );
  expect(mocks.store).not.toHaveBeenCalled();
});

it("saves only the current token and account to the server-scoped native bridge", async () => {
  auth.setToken("protected-token", user.id);
  await biometric.enableBiometrics();
  expect(mocks.store).toHaveBeenCalledWith({
    server,
    token: "protected-token",
    userId: user.id,
    language: "en-US",
  });
  expect(localStorage.setItem).not.toHaveBeenCalled();
});

it("requires server validation after a successful scan and omits WebView cookies", async () => {
  const result = await biometric.signInWithBiometrics();
  expect(result.user.id).toBe(user.id);
  expect(auth.currentSession().userId).toBe(user.id);
  expect(fetch).toHaveBeenCalledWith(
    `${server}/auth/me`,
    expect.objectContaining({ credentials: "omit" }),
  );
  const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Headers;
  expect(headers.get("Authorization")).toBe("Bearer protected-token");
  expect(headers.get("X-Account-ID")).toBe(user.id);
  for (const [key, value] of vi.mocked(localStorage.setItem).mock.calls) {
    expect(key).toBe("mewmo:installation");
    expect(value).not.toContain("protected-token");
  }
});

it("does not contact the API or set a token when Face ID is cancelled", async () => {
  mocks.restore.mockRejectedValueOnce(new Error("Sign-in cancelled."));
  await expect(biometric.signInWithBiometrics()).rejects.toThrow("cancelled");
  expect(auth.currentSession().token).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
});

it("clears expired or revoked credentials and requires a password", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('{"detail":"Please sign in"}', { status: 401 }),
  );
  await expect(biometric.signInWithBiometrics()).rejects.toThrow(
    "expired or been revoked",
  );
  expect(auth.currentSession().token).toBeNull();
  expect(mocks.clear).toHaveBeenCalledWith({ server });
});

it("keeps protected credentials for retry after a network failure", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("Network unavailable"));
  await expect(biometric.signInWithBiometrics()).rejects.toThrow(
    "Network unavailable",
  );
  expect(auth.currentSession().token).toBeNull();
  expect(mocks.clear).not.toHaveBeenCalled();
});

it("rejects a server response for a different account", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ user: { ...user, id: "bob-id" } })),
  );
  await expect(biometric.signInWithBiometrics()).rejects.toThrow(
    "Sign in with your password",
  );
  expect(auth.currentSession().token).toBeNull();
  expect(mocks.clear).toHaveBeenCalled();
});

it("does not replace a new account when an old Face ID prompt completes late", async () => {
  let finish!: (value: { token: string; userId: string }) => void;
  mocks.restore.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = biometric.signInWithBiometrics();
  await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalled());
  auth.setToken("bob-token", "bob-id");
  finish({ token: "protected-token", userId: user.id });
  await expect(pending).rejects.toThrow("Account changed");
  expect(auth.currentSession().token).toBe("bob-token");
  expect(fetch).not.toHaveBeenCalled();
});

it("clears a pending opt-in if sign-out occurs during its system prompt", async () => {
  let finish!: () => void;
  mocks.store.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  auth.setToken("protected-token", user.id);
  const pending = biometric.enableBiometrics();
  const rejected = expect(pending).rejects.toThrow("Account changed");
  await vi.waitFor(() => expect(mocks.store).toHaveBeenCalled());
  auth.setToken(null);
  const cleared = biometric.clearBiometrics();
  finish();
  await rejected;
  await cleared;
  expect(mocks.clear).toHaveBeenCalled();
  expect(auth.currentSession().token).toBeNull();
});

it("retains cookie authentication for the website", async () => {
  mocks.platform.mockReturnValue("web");
  await auth.api("/auth/me");
  expect(fetch).toHaveBeenCalledWith(
    `${server}/auth/me`,
    expect.objectContaining({ credentials: "include" }),
  );
});

it("passes the selected language to native setup and unlock prompts", async () => {
  const { setLanguage } = await import("./i18n");
  setLanguage("zh-CN");
  auth.setToken("protected-token", user.id);
  await biometric.enableBiometrics();
  expect(mocks.store).toHaveBeenCalledWith(
    expect.objectContaining({ language: "zh-CN" }),
  );
  auth.setToken(null);
  await biometric.signInWithBiometrics();
  expect(mocks.restore).toHaveBeenCalledWith({ server, language: "zh-CN" });
});
