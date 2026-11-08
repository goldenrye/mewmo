import { getLocale, t } from "./i18n";

export type Kind = "bill" | "appointment" | "dated_item";
export type State = "open" | "paid" | "completed";
export type Rule = {
  mode: "before" | "day";
  minutes: number;
  days: number;
  at: string;
};
export type Draft = {
  kind: Kind;
  title: string;
  payee: string | null;
  amount: string | number | null;
  currency: string | null;
  account_last4: string | null;
  due_date: string | null;
  due_time: string | null;
  timezone: string;
  status: State;
  rules: Rule[];
  uncertain: string[];
  warnings: string[];
  duplicates: string[];
  source: "manual" | "text" | "file";
};
export type Item = Omit<
  Draft,
  "uncertain" | "warnings" | "duplicates" | "source"
> & {
  id: string;
  due_at: string;
  created_at: string;
  finished_at: string | null;
};
export type Reminder = {
  id: string;
  fire_at: string;
  rule_key: string;
  status: string;
  attempts: number;
  sent_at: string | null;
  error: string | null;
  deliveries: {
    platform: string;
    status: string;
    error: string | null;
    accepted_at: string | null;
  }[];
};
export type Device = { id: string; platform: string; active: boolean };
export type Note = {
  id: string;
  title: string;
  body: string;
  version: number;
  created_at: string;
  updated_at: string;
};
export type NoteResults = {
  items: Note[];
  total: number;
  mode: "local" | "ai";
  warning: string | null;
};
export type User = {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
};
export type Account = { user: User; vapid_public_key: string };
export type AuthResult = Account & { token: string | null };
export type ModelSettings = {
  available: boolean;
  provider: "openai" | "anthropic" | "gemini" | "doubao";
  model: string;
  has_key: boolean;
  enabled: boolean;
  allow_images: boolean;
  allow_note_search: boolean;
};
export type Invitation = {
  id: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "used" | "expired" | "revoked";
};

export function context() {
  const now = new Date();
  return {
    local_date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function defaults(kind: Kind): Rule[] {
  if (kind === "appointment")
    return [1440, 60].map((minutes) => ({
      mode: "before",
      minutes,
      days: 0,
      at: "09:00",
    }));
  return [
    ...[10080, 1440].map((minutes) => ({
      mode: "before" as const,
      minutes,
      days: 0,
      at: "09:00",
    })),
    ...(kind === "bill" ? [0, 1] : [0]).map((days) => ({
      mode: "day" as const,
      minutes: 60,
      days,
      at: "09:00",
    })),
  ];
}

export function manualDraft(kind: Kind = "bill"): Draft {
  return {
    kind,
    title: "",
    payee: "",
    amount: null,
    currency: "USD",
    account_last4: null,
    due_date: context().local_date,
    due_time: "09:00",
    timezone: context().timezone,
    status: "open",
    rules: defaults(kind),
    uncertain: [],
    warnings: [],
    duplicates: [],
    source: "manual",
  };
}

export function fullDate(day: string | null, time: string | null): string {
  if (!day || !time) return t("Choose a date and time to continue");
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return t("Choose a valid date");
  return t("{date} at {time}", {
    date: d.toLocaleDateString(getLocale(), {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }),
    time,
  });
}

export function money(item: Pick<Item, "amount" | "currency">) {
  if (item.amount === null || !item.currency) return "";
  try {
    return new Intl.NumberFormat(getLocale(), {
      style: "currency",
      currency: item.currency,
    }).format(Number(item.amount));
  } catch {
    return `${item.currency} ${item.amount}`;
  }
}

export const kindName = {
  bill: "Bill",
  appointment: "Appointment",
  dated_item: "Dated item",
};
