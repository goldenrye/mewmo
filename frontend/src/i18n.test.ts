import { afterEach, expect, it, vi } from "vitest";
import {
  deliveryMessage,
  getLanguagePreference,
  getLocale,
  messageText,
  setLanguage,
  t,
} from "./i18n";
import { context, defaults, fullDate, manualDraft, money } from "./types";
import catalog from "./zh-CN.json";

afterEach(() => {
  setLanguage("system");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("detects Chinese devices and falls back to English for unsupported languages", () => {
  vi.stubGlobal("navigator", { languages: ["zh-TW"], language: "zh-TW" });
  expect(getLocale()).toBe("zh-CN");
  expect(t("Settings")).toBe("设置");
  vi.stubGlobal("navigator", { languages: ["fr-FR"], language: "fr-FR" });
  expect(getLocale()).toBe("en-US");
});

it("explicit language overrides the device and persists only the preference", () => {
  const storage = { setItem: vi.fn() };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { languages: ["zh-CN"] });
  setLanguage("en");
  expect(getLocale()).toBe("en-US");
  expect(storage.setItem).toHaveBeenCalledWith("mewmo:language", "en");
  expect(getLanguagePreference()).toBe("en");
});

it("still switches languages when storage is unavailable", () => {
  vi.stubGlobal("localStorage", {
    setItem: () => {
      throw new Error("Storage blocked");
    },
  });
  expect(() => setLanguage("zh-CN")).not.toThrow();
  expect(t("Sign in")).toBe("登录");
});

it("formats the regression date in Chinese without changing the date or time", () => {
  setLanguage("zh-CN");
  expect(fullDate("2026-11-08", "09:00")).toContain("2026年11月8日");
  expect(fullDate("2026-11-08", "09:00")).toContain("星期日");
  expect(fullDate("2026-11-08", "09:00")).toContain("09:00");
  expect(fullDate(null, "09:00")).toBe("请选择日期和时间");
  setLanguage("en");
  expect(fullDate("2026-11-08", "09:00")).toBe(
    "Sunday, November 8, 2026 at 09:00",
  );
});

it("does not change currencies, dates, zones or reminder rules with language", () => {
  const original = {
    context: context(),
    rules: defaults("bill"),
    draft: manualDraft(),
  };
  setLanguage("zh-CN");
  expect(context()).toEqual(original.context);
  expect(defaults("bill")).toEqual(original.rules);
  expect(manualDraft()).toEqual(original.draft);
  expect(manualDraft().currency).toBe("USD");
  expect(money({ amount: "120.50", currency: "USD" })).toContain("120.50");
});

it("interpolates user data once without translating or interpreting it", () => {
  setLanguage("zh-CN");
  expect(
    t("Mark {title} as paid", { title: "Settings {date} <b>我的账单</b>" }),
  ).toBe("将“Settings {date} <b>我的账单</b>”标记为已支付");
  expect(t("constructor")).toBe("constructor");
  expect(t("__proto__")).toBe("__proto__");
  expect(messageText("Unknown provider failure")).toBe(
    "Unknown provider failure",
  );
});

it("localizes auth, parser, validation and native errors without hiding their meaning", () => {
  setLanguage("zh-CN");
  expect(messageText("Incorrect username or password")).toBe(
    "用户名或密码不正确",
  );
  expect(messageText("Value error, This field cannot be empty")).toBe(
    "此项不能为空",
  );
  expect(messageText("String should have at least 12 characters")).toBe(
    "请输入至少 12 个字符",
  );
  expect(
    messageText("Please confirm the currency; interpreted 刀 as USD."),
  ).toContain("USD");
  expect(
    messageText("Sign-in cancelled. Try again or use your password."),
  ).toContain("密码");
  expect(messageText("apns_http_403")).toContain("403");
  expect(deliveryMessage("no_registered_device")).toBe("尚未注册通知设备");
  setLanguage("en");
  expect(deliveryMessage("no_registered_device")).toBe("no registered device");
});

it("keeps all translation placeholders intact", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [key, translation] of Object.entries(catalog)) {
    expect(translation.trim(), key).not.toBe("");
    expect(placeholders(translation), key).toEqual(placeholders(key));
  }
});
