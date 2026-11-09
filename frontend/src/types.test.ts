import { afterEach, describe, expect, it, vi } from "vitest";
import { context, defaults, fullDate, manualDraft } from "./types";

afterEach(() => vi.useRealTimers());

describe("shared client contracts", () => {
  it("sends device-local calendar date and IANA zone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 6, 9));
    expect(context()).toEqual({
      local_date: "2026-11-06",
      client_now: new Date(2026, 10, 6, 9).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });
  it("renders the required unambiguous confirmation", () => {
    expect(fullDate("2026-11-08", "09:00")).toBe(
      "Sunday, November 8, 2026 at 09:00",
    );
  });
  it("does not invent missing dates", () => {
    expect(fullDate(null, "09:00")).toContain("Choose a date");
  });
  it("matches server reminder defaults", () => {
    expect(defaults("appointment").map((r) => r.minutes)).toEqual([1440, 60]);
    expect(defaults("bill").map((r) => r.mode)).toEqual([
      "before",
      "before",
      "day",
      "day",
    ]);
    expect(defaults("bill").at(-1)).toMatchObject({ days: 1, at: "09:00" });
    expect(defaults("dated_item")).toHaveLength(3);
  });
  it("starts manual entry as a draft", () => {
    expect(manualDraft()).toMatchObject({
      source: "manual",
      status: "open",
      title: "",
      amount: null,
    });
  });
});
