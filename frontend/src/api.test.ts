import { afterEach, expect, it, vi } from "vitest";
import { api, setToken } from "./api";
import { context } from "./types";

afterEach(() => {
  setToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("attaches local date and IANA timezone to every request", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  await api("/items");
  const headers = fetch.mock.calls[0][1]?.headers as Headers;
  expect(headers.get("X-Client-Date")).toBe(context().local_date);
  expect(headers.get("X-Client-Timezone")).toBe(context().timezone);
  expect(headers.get("X-Client-Key")).toMatch(/^[0-9a-f]{64}$/);
});

it("binds requests to the displayed account without persisting its token", async () => {
  setToken("native-session", "alice-id");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("[]"));
  await api("/items");
  const headers = fetch.mock.calls[0][1]?.headers as Headers;
  expect(headers.get("X-Account-ID")).toBe("alice-id");
  expect(headers.get("Authorization")).toBe("Bearer native-session");
});

it("discards delayed responses from a previous account", async () => {
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  setToken(null, "alice-id");
  const request = api("/items");
  setToken(null, "bob-id");
  finish(new Response('[{"title":"Alice private bill"}]'));
  await expect(request).rejects.toThrow("Account changed");
});

it("does not sign out the new account when an old request returns unauthorized", async () => {
  const events = new EventTarget();
  const unauthorized = vi.fn();
  events.addEventListener("mewmo:unauthorized", unauthorized);
  vi.stubGlobal("window", events);
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  setToken(null, "alice-id");
  const request = api("/items");
  setToken(null, "bob-id");
  finish(new Response('{"detail":"Please sign in"}', { status: 401 }));
  await expect(request).rejects.toThrow("Account changed");
  expect(unauthorized).not.toHaveBeenCalled();
});
