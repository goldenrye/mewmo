import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { context } from "./types";

afterEach(() => vi.restoreAllMocks());

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
});
