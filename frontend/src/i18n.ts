import { useSyncExternalStore } from "react";
import chinese from "./zh-CN.json";

export type LanguagePreference = "system" | "en" | "zh-CN";
const storageKey = "mewmo:language";
const listeners = new Set<() => void>();
const translations: Readonly<Record<string, string>> = chinese;
const english = new Map(
  Object.entries(translations).map(([key, value]) => [value, key]),
);

function validPreference(value: unknown): LanguagePreference {
  return value === "en" || value === "zh-CN" ? value : "system";
}
function readPreference(): LanguagePreference {
  try {
    return validPreference(localStorage.getItem(storageKey));
  } catch {
    return "system";
  }
}
let preference = readPreference();

export function getLocale(): "en-US" | "zh-CN" {
  if (preference === "zh-CN") return "zh-CN";
  if (preference === "en") return "en-US";
  const language =
    typeof navigator === "undefined"
      ? "en"
      : navigator.languages?.[0] || navigator.language;
  return /^zh(?:-|$)/i.test(language) ? "zh-CN" : "en-US";
}
export function getLanguagePreference() {
  return preference;
}
function emit() {
  if (typeof document !== "undefined")
    document.documentElement.lang = getLocale();
  listeners.forEach((listener) => listener());
}
export function setLanguage(value: LanguagePreference) {
  preference = validPreference(value);
  try {
    localStorage.setItem(storageKey, preference);
  } catch {
    /* Session-only when storage is blocked. */
  }
  emit();
}
export function useLanguage() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => `${preference}:${getLocale()}`,
    () => "system:en-US",
  );
  return {
    preference: current.split(":")[0] as LanguagePreference,
    locale: getLocale(),
  };
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) {
      preference =
        event.key === null ? "system" : validPreference(event.newValue);
      emit();
    }
  });
  window.addEventListener("languagechange", emit);
}
emit();

/** Translate interface copy only; never apply this to user titles, payees, or names. */
export function t(
  key: string,
  values: Record<string, string | number> = {},
): string {
  const text =
    getLocale() === "zh-CN"
      ? Object.prototype.hasOwnProperty.call(translations, key)
        ? translations[key]
        : key
      : english.get(key) || key;
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : placeholder,
  );
}

export function messageText(message: string): string {
  if (getLocale() !== "zh-CN") return t(message);
  if (Object.prototype.hasOwnProperty.call(translations, message))
    return translations[message];
  if (message.startsWith("Value error, "))
    return messageText(message.slice(13));
  const currency =
    /^Please confirm the currency; interpreted (.+) as (.+)\.$/.exec(message);
  if (currency)
    return t(
      "Please confirm the currency; interpreted {symbol} as {currency}.",
      { symbol: currency[1], currency: currency[2] },
    );
  const length =
    /^String should have (at least|at most) (\d+) characters?$/.exec(message);
  if (length)
    return `请输入${length[1] === "at least" ? "至少" : "至多"} ${length[2]} 个字符`;
  const number =
    /^Input should be (greater than or equal to|less than or equal to) (.+)$/.exec(
      message,
    );
  if (number)
    return `数值应${number[1].startsWith("greater") ? "不小于" : "不大于"} ${number[2]}`;
  if (message.startsWith("String should match pattern"))
    return "格式不正确，请检查输入";
  if (
    /^(Failed to fetch|Load failed|NetworkError|Network request failed)/.test(
      message,
    )
  )
    return t(
      "Network unavailable. Please check your connection and try again.",
    );
  if (message.startsWith("Username is required."))
    return "请填写用户名。如果登录页只有密码输入框，请更新 iPhone 应用或刷新网页后重试。";
  if (/^(apns|web_push)_http_\d+$/.test(message))
    return `推送服务返回错误（${message.split("_").at(-1)}）`;
  return message;
}

export function deliveryMessage(code: string): string {
  const translated = messageText(code);
  return translated === code ? code.replaceAll("_", " ") : translated;
}

export function fieldName(field: string): string {
  if (getLocale() !== "zh-CN") return field;
  const names: Record<string, string> = {
    username: "用户名",
    password: "密码",
    current_password: "当前密码",
    new_password: "新密码",
    display_name: "姓名",
    invite_token: "邀请码",
    title: "标题",
    payee: "收款方",
    amount: "金额",
    currency: "币种",
    due_date: "日期",
    due_time: "时间",
    timezone: "时区",
    rules: "提醒规则",
    account_last4: "账户尾号",
    confirmed: "确认保存",
    minutes: "分钟数",
    days: "天数",
    at: "时间",
  };
  return field
    .split(".")
    .map((part) => names[part] || part)
    .join(".");
}
