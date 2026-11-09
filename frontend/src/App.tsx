import {
  deliveryMessage,
  getLocale,
  messageText,
  t,
  useLanguage,
} from "./i18n";
import { LanguageSelector } from "./LanguageSelector";
import { useFormLanguage } from "./formLanguage";
import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  Plus,
  Search,
  ScanFace,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { api, apiBase, currentSession, setToken } from "./api";
import {
  alarmEpoch,
  alarmRevision,
  bindAlarmAccount,
  disableAlarms,
  syncAlarms,
} from "./alarms";
import {
  AlarmCleanupWarning,
  UrgentAlarmDetails,
  UrgentAlarmSettings,
} from "./UrgentAlarms";
import {
  biometricStatus,
  clearBiometrics,
  signInWithBiometrics,
  type BiometricStatus,
} from "./biometrics";
import { Editor } from "./Editor";
import { AccountSettings } from "./AccountSettings";
import { VoiceInput } from "./VoiceInput";
import { Notes } from "./Notes";
import {
  clearDisplayedNotifications,
  enableNotifications,
} from "./notifications";
import {
  context,
  fullDate,
  kindName,
  manualDraft,
  money,
  type Account,
  type AuthResult,
  type Device,
  type Draft,
  type Item,
  type Kind,
  type ModelSettings,
  type Reminder,
} from "./types";

type Page = "overview" | "calendar" | "history" | "notifications" | "settings";
const icons = { bill: FileText, appointment: CalendarDays, dated_item: Clock3 };

function Brand() {
  return (
    <div className="brand">
      <img
        className="brand-mark"
        src="/icon-192.png"
        alt=""
        width={37}
        height={37}
      />
      <span>
        mewmo<span className="brand-dot">.</span>
      </span>
    </div>
  );
}

function Login({
  onLogin,
  invitation,
}: {
  onLogin: (result: AuthResult) => void;
  invitation: string;
}) {
  const [register, setRegister] = useState(!!invitation);
  const [invite, setInvite] = useState(invitation);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [biometric, setBiometric] = useState<BiometricStatus | null>(null);
  useEffect(() => {
    let live = true;
    void biometricStatus()
      .then((value) => {
        if (live) setBiometric(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  async function biometricLogin() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onLogin(await signInWithBiometrics());
    } catch (error) {
      setError((error as Error).message);
      setBiometric(await biometricStatus().catch(() => null));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const version = currentSession().version;
    setBusy(true);
    setError("");
    try {
      if (register && password !== confirmation)
        throw new Error(t("Passwords do not match."));
      let inviteToken = invite.trim();
      if (inviteToken.includes("#")) {
        inviteToken =
          new URLSearchParams(inviteToken.split("#")[1]).get("invite") || "";
      }
      const result = await api<AuthResult>(
        register ? "/auth/register" : "/auth/login",
        {
          method: "POST",
          body: JSON.stringify({
            username,
            password,
            ...(register
              ? { display_name: name, invite_token: inviteToken }
              : {}),
          }),
        },
      );
      // Password/account switching never inherits another account's saved session.
      await clearBiometrics();
      if (currentSession().version !== version)
        throw new Error(t("Account changed. Please try again."));
      onLogin(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <p>{t("Bills and reminders, in one place.")}</p>
      </div>
      <div className="login-form">
        <LanguageSelector />
        <form onSubmit={submit}>
          <h2>
            {register
              ? t("Create your private account")
              : t("Welcome to Mewmo")}
          </h2>
          {register && (
            <p className="muted">{t("An invitation is required to join.")}</p>
          )}
          {!register && biometric?.enabled && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void biometricLogin()}
            >
              <ScanFace size={20} />
              {t("Sign in with {method}", { method: t(biometric.label) })}
            </button>
          )}
          {register && (
            <>
              <label>
                {t("Invitation link or code")}
                <input
                  required
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                {t("Your name")}
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </label>
            </>
          )}
          <label>
            {t("Username")}
            <input
              required
              minLength={3}
              maxLength={40}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            {t("Your password")}
            <input
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              required
              minLength={register ? 12 : 1}
              maxLength={512}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {register && (
            <>
              <label>
                {t("Confirm password")}
                <input
                  type="password"
                  required
                  minLength={12}
                  maxLength={512}
                  autoComplete="new-password"
                  aria-describedby="signup-password-hint"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
              <small id="signup-password-hint">
                {t("Use at least 12 characters.")}
              </small>
            </>
          )}
          {error && (
            <p role="alert" className="error">
              {messageText(error)}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? t("Please wait...")
              : register
                ? t("Create account")
                : t("Sign in")}
            <ArrowRight size={18} />
          </button>
          <button
            type="button"
            className="text-button auth-toggle"
            disabled={busy}
            onClick={() => {
              setRegister(!register);
              setError("");
              setPassword("");
              setConfirmation("");
            }}
          >
            {register
              ? t("Back to sign in")
              : t("Have an invitation? Join Mewmo")}
          </button>
        </form>
      </div>
    </div>
  );
}

function ItemDetail({
  item,
  onUpdated,
  onClose,
  onEdit,
  onState,
  onDelete,
}: {
  item: Item;
  onUpdated: (item: Item) => void;
  onClose: () => void;
  onEdit: () => void;
  onState: (item: Item) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    const load = () =>
      api<Reminder[]>(`/items/${item.id}/reminders`)
        .then((rows) => {
          if (live) {
            setReminders(rows);
            setError("");
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [item.id]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="editor-dialog detail-dialog"
      onCancel={onClose}
    >
      <div className="dialog-heading">
        <span className={`type-icon ${item.kind}`}>
          {(() => {
            const Icon = icons[item.kind];
            return <Icon size={23} />;
          })()}
        </span>
        <button
          aria-label={t("Close details")}
          className="icon-button"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <span className="eyebrow">
        {t(kindName[item.kind])} · {t(item.status)}
      </span>
      <h2>{item.title}</h2>
      {item.kind === "bill" && (
        <div className="detail-amount">
          {money(item)} <span>{item.currency}</span>
        </div>
      )}
      <div className="date-preview">
        <CalendarDays size={20} />
        <div>
          <strong>{fullDate(item.due_date, item.due_time)}</strong>
          <span>{item.timezone}</span>
        </div>
      </div>
      {item.payee && (
        <p className="muted">
          {t("Payee: {payee}", { payee: item.payee })}
          {item.account_last4 &&
            ` · ${t("Account ending {digits}", { digits: item.account_last4 })}`}
        </p>
      )}
      <div className="detail-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void action(() => onState(item))}
        >
          <Check size={16} />
          {item.status !== "open"
            ? t("Reopen item")
            : item.kind === "bill"
              ? t("Mark as paid")
              : t("Mark complete")}
        </button>
        <button className="secondary" onClick={onEdit}>
          {t("Edit item")}
        </button>
      </div>
      <section className="delivery-list">
        {item.urgent && (
          <UrgentAlarmDetails item={item} onUpdated={onUpdated} />
        )}
        <div className="section-heading">
          <h3>
            <Bell size={17} />
            {t("Reminder delivery")}
          </h3>
        </div>
        <p className="muted small">
          {t("Sent means accepted by the push service, not read.")}
        </p>
        {loading && <p className="muted">{t("Loading reminder status…")}</p>}
        {!loading && !reminders.length && (
          <p className="empty-inline">
            {t("No future reminders were scheduled. Past times are skipped.")}
          </p>
        )}
        {reminders.map((r) => (
          <div className="delivery-row" key={r.id}>
            <div>
              <strong>
                {new Date(r.fire_at).toLocaleString(getLocale(), {
                  timeZone: item.timezone,
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </strong>
              {r.error && (
                <p className="delivery-error">{deliveryMessage(r.error)}</p>
              )}
              {(r.attempts > 0 || r.deliveries.length > 0) && (
                <details className="delivery-details">
                  <summary>{t("Delivery details")}</summary>
                  <p>
                    {t(
                      r.attempts === 1 ? "{count} attempt" : "{count} attempts",
                      { count: r.attempts },
                    )}
                  </p>
                  {r.deliveries.map((d, i) => (
                    <p key={i}>
                      {d.platform === "ios" ? "iPhone" : t("Web")}:{" "}
                      {t(d.status)}
                      {d.error && ` (${deliveryMessage(d.error)})`}
                    </p>
                  ))}
                </details>
              )}
            </div>
            <span className={`status-pill ${r.status}`}>{t(r.status)}</span>
          </div>
        ))}
      </section>
      {error && (
        <p className="error" role="alert">
          {messageText(error)}
        </p>
      )}
      <div className="delete-section">
        {confirmDelete ? (
          <>
            <p>{t("Delete this item and cancel its unsent reminders?")}</p>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void action(onDelete)}
            >
              {t("Yes, delete item")}
            </button>
            <button
              className="text-button"
              onClick={() => setConfirmDelete(false)}
            >
              {t("Keep item")}
            </button>
          </>
        ) : (
          <button
            className="text-button danger"
            onClick={() => setConfirmDelete(true)}
          >
            {t("Delete item")}
          </button>
        )}
      </div>
    </dialog>
  );
}

export default function App() {
  useLanguage();
  useFormLanguage();
  const [account, setAccount] = useState<Account | null>();
  const [invitation, setInvitation] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("invite") || "",
  );
  const initialInvitation = useRef(invitation).current;
  function notifyOtherTabs() {
    try {
      localStorage.setItem("mewmo:auth-event", crypto.randomUUID());
    } catch {
      /* Storage may be disabled. */
    }
  }
  const clearAccount = useCallback(() => {
    setToken(null);
    void bindAlarmAccount(null).catch(() => {});
    setAccount(null);
    void clearBiometrics().catch(() => {});
    void clearDisplayedNotifications();
  }, []);
  useEffect(() => {
    let live = true;
    if (initialInvitation) {
      window.history.replaceState({}, "", location.pathname + location.search);
      setAccount(null);
      void clearBiometrics().catch(() => {});
    } else if (Capacitor.isNativePlatform()) {
      // A cold native launch must use a password or unlock Keychain, never a cookie.
      setAccount(null);
    } else {
      void api<Account>("/auth/me")
        .then((value) => {
          if (live) {
            setToken(null, value.user.id);
            setAccount(value);
          }
        })
        .catch(() => {
          if (live) setAccount(null);
        });
    }
    const storage = (event: StorageEvent) => {
      if (event.key === "mewmo:auth-event") clearAccount();
    };
    const readInvitation = () => {
      const token = new URLSearchParams(location.hash.slice(1)).get("invite");
      if (!token) return;
      clearAccount();
      setInvitation(token);
      window.history.replaceState({}, "", location.pathname + location.search);
    };
    window.addEventListener("mewmo:unauthorized", clearAccount);
    window.addEventListener("storage", storage);
    window.addEventListener("hashchange", readInvitation);
    return () => {
      live = false;
      window.removeEventListener("mewmo:unauthorized", clearAccount);
      window.removeEventListener("storage", storage);
      window.removeEventListener("hashchange", readInvitation);
    };
  }, [clearAccount, initialInvitation]);
  if (account === undefined) {
    return (
      <div className="loading-page">
        <Brand />
        <p>{t("Making a little space...")}</p>
      </div>
    );
  }
  if (!account) {
    return (
      <>
        <AlarmCleanupWarning />
        <Login
          key={invitation || "login"}
          invitation={invitation}
          onLogin={(result) => {
            setToken(result.token, result.user.id);
            void bindAlarmAccount(result.user.id, apiBase).catch(() => {});
            setInvitation("");
            setAccount(result);
            void clearDisplayedNotifications();
            notifyOtherTabs();
          }}
        />
      </>
    );
  }
  return (
    <Workspace
      key={account.user.id}
      account={account}
      onSignOut={async () => {
        await disableAlarms();
        await clearBiometrics();
        await api("/auth/logout", { method: "POST" });
        clearAccount();
        notifyOtherTabs();
      }}
    />
  );
}

function Workspace({
  account,
  onSignOut,
}: {
  account: Account;
  onSignOut: () => Promise<void>;
}) {
  const [page, setPage] = useState<Page>("overview");
  const [homeView, setHomeView] = useState<"reminders" | "notes">("reminders");
  const [items, setItems] = useState<Item[]>([]);
  const [finished, setFinished] = useState<Item[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const vapid = account.vapid_public_key;
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(
    null,
  );
  const [imageAI, setImageAI] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editId, setEditId] = useState<string>();
  const [selected, setSelected] = useState<Item | null>(null);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<{ message: string; undo?: Item } | null>(
    null,
  );
  const [working, setWorking] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [month, setMonth] = useState(new Date());
  const [day, setDay] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const file = useRef<HTMLInputElement>(null);
  const capture = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (voiceBusy && capture.current)
      capture.current.scrollTop = capture.current.scrollHeight;
  }, [text, voiceBusy]);
  const today = context().local_date;
  useEffect(() => {
    let live = true;
    setImageAI(false);
    void api<ModelSettings>("/model-settings")
      .then((value) => {
        if (live) setModelSettings(value);
      })
      .catch(() => {
        if (live) setModelSettings(null);
      });
    return () => {
      live = false;
    };
  }, [page]);
  const refresh = useCallback(async () => {
    const revision = alarmRevision();
    const [open, history, registered] = await Promise.all([
      api<Item[]>("/items"),
      api<Item[]>("/items?history=true"),
      api<Device[]>("/devices"),
    ]);
    setItems(open);
    setFinished(history);
    setDevices(registered);
    await syncAlarms(open, {
      complete: true,
      expectedRevision: revision,
    }).catch(() => {});
  }, []);
  useEffect(() => {
    setLoading(true);
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    const timer = setInterval(() => {
      setClock(Date.now());
      void refresh().catch((e) => setError(e.message));
    }, 60000);
    const resume = () => {
      if (!document.hidden) void refresh().catch((e) => setError(e.message));
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [refresh]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("item");
    const found = [...items, ...finished].find((i) => i.id === id);
    if (found) {
      setSelected(found);
      window.history.replaceState({}, "", "/");
    }
  }, [items, finished]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const listener = PushNotifications.addListener(
      "pushNotificationActionPerformed",
      (event) => {
        const id = event.notification.data.item_id;
        const found = [...items, ...finished].find((i) => i.id === id);
        if (found) setSelected(found);
        else {
          window.history.replaceState(
            {},
            "",
            `/?item=${encodeURIComponent(id)}`,
          );
          void refresh();
        }
      },
    );
    return () => {
      void listener.then((l) => l.remove());
    };
  }, [items, finished, refresh]);

  function newItem(kind: Kind = "bill") {
    setEditId(undefined);
    setDraft(manualDraft(kind));
  }
  async function parseInput() {
    if (!text.trim() || parsing || voiceBusy) return;
    if (text.length > 4000) {
      setImportError(t("Keep reminder text under 4,000 characters."));
      return;
    }
    setParsing(true);
    setImportError("");
    try {
      const result = await api<Draft>("/drafts/text", {
        method: "POST",
        body: JSON.stringify({ text, ...context() }),
      });
      setEditId(undefined);
      setDraft(result);
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setParsing(false);
    }
  }
  async function importFile(value?: File) {
    if (!value || parsing || voiceBusy) return;
    if (value.size > 12 * 1024 * 1024) {
      setImportError(t("Please choose a file smaller than 12 MB."));
      return;
    }
    setParsing(true);
    setImportError("");
    try {
      const query = new URLSearchParams(context());
      if (imageAI && modelSettings?.enabled && modelSettings.allow_images) {
        query.set("use_image_ai", "true");
        query.set("image_provider", modelSettings.provider);
        if (modelSettings.revision !== undefined)
          query.set("image_revision", String(modelSettings.revision));
        if (modelSettings.image_chain_token)
          query.set("image_chain", modelSettings.image_chain_token);
      }
      const result = await api<Draft>(`/drafts/file?${query}`, {
        method: "POST",
        body: value,
        headers: { "Content-Type": "application/octet-stream" },
      });
      setEditId(undefined);
      setDraft(result);
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setParsing(false);
      setImageAI(false);
      if (file.current) file.current.value = "";
    }
  }
  async function changeState(item: Item, undo = false) {
    const epoch = alarmEpoch();
    setWorking(item.id);
    setError("");
    try {
      const updated = await api<Item>(`/items/${item.id}/state`, {
        method: "POST",
        body: JSON.stringify({
          status:
            undo || item.status !== "open"
              ? "open"
              : item.kind === "bill"
                ? "paid"
                : "completed",
        }),
      });
      await syncAlarms([updated], { force: true, expectedEpoch: epoch }).catch(
        () => {},
      );
      setSelected(null);
      setToast({
        message:
          undo || item.status !== "open"
            ? t("Item reopened.")
            : item.kind === "bill"
              ? t("Marked as paid.")
              : t("Completed."),
        undo: !undo && item.status === "open" ? item : undefined,
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setWorking(null);
    }
  }
  async function enablePush() {
    setPushBusy(true);
    setError("");
    try {
      await enableNotifications(vapid);
      await refresh();
      setToast({ message: t("Notifications enabled on this device.") });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPushBusy(false);
    }
  }
  const overdue = items.filter((i) => new Date(i.due_at).getTime() < clock);
  const source = page === "history" ? finished : items;
  const visible = source.filter(
    (i) =>
      (filter === "all" || filter === i.kind) &&
      (!search ||
        `${i.title} ${i.payee || ""}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (page !== "calendar" || !day || i.due_date === day),
  );
  const navigation: { key: Page; label: string; icon: typeof Bell }[] = [
    { key: "overview", label: t("Overview"), icon: LayoutDashboard },
    { key: "calendar", label: t("Calendar"), icon: CalendarDays },
    { key: "history", label: t("History"), icon: History },
    { key: "notifications", label: t("Notifications"), icon: Bell },
  ];
  function navigate(next: Page) {
    setPage(next);
    setFilter("all");
    setDay(null);
    setSearch("");
  }
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const calendarDays = Array.from(
    { length: 42 },
    (_, i) =>
      new Date(
        month.getFullYear(),
        month.getMonth(),
        i - monthStart.getDay() + 1,
      ),
  );
  const calendar = (
    <div className="mini-calendar">
      <div className="section-heading">
        <h3>
          {month.toLocaleDateString(getLocale(), {
            month: "long",
            year: "numeric",
          })}
        </h3>
        <div className="calendar-arrows">
          <button
            className="icon-button"
            aria-label={t("Previous month")}
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
            }
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={t("Next month")}
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
            }
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="calendar-grid">
        {(getLocale() === "zh-CN"
          ? ["日", "一", "二", "三", "四", "五", "六"]
          : ["S", "M", "T", "W", "T", "F", "S"]
        ).map((s, i) => (
          <span className="weekday" key={i}>
            {s}
          </span>
        ))}
        {calendarDays.map((d) => {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const count = items.filter((i) => i.due_date === key).length;
          return (
            <button
              key={key}
              aria-label={t("{date}, {count} items", {
                date:
                  getLocale() === "en-US"
                    ? d.toDateString()
                    : d.toLocaleDateString(getLocale(), {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        weekday: "long",
                      }),
                count,
              })}
              className={`${key === today ? "today" : ""} ${key === day ? "chosen" : ""} ${d.getMonth() !== month.getMonth() ? "outside" : ""}`}
              onClick={() => {
                setPage("calendar");
                setDay(key);
              }}
            >
              {d.getDate()}
              {count > 0 && <i />}
            </button>
          );
        })}
      </div>
      <div className="calendar-legend">
        <i />
        {t("Items to remember")}
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label={t("Main navigation")}>
          {navigation.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              aria-label={label}
              className={page === key ? "active" : ""}
              aria-current={page === key ? "page" : undefined}
              onClick={() => navigate(key)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {key === "overview" && items.length > 0 && (
                <small>{items.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} />
            {t("Settings")}
          </button>
          <div className="profile">
            <span>{account.user.display_name[0].toUpperCase()}</span>
            <div>
              <strong>{account.user.display_name}</strong>
              <small>
                {account.user.is_admin
                  ? t("Administrator")
                  : t("Personal account")}
              </small>
            </div>
            <button
              aria-label={t("Sign out")}
              className="icon-button"
              onClick={() => void onSignOut().catch((e) => setError(e.message))}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="topbar-name">
            <img
              className="brand-mark"
              src="/icon-192.png"
              alt=""
              width={28}
              height={28}
            />
            Mewmo
          </span>
          <div className="topbar-right">
            <span className="today-label">
              <CalendarDays size={15} />
              {new Date(clock).toLocaleDateString(getLocale(), {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            <button
              className="icon-button notification-button"
              aria-label={t("Open notifications")}
              onClick={() => navigate("notifications")}
            >
              <Bell size={19} />
              {devices.some((d) => d.active) && <i />}
            </button>
            <span className="avatar">
              {account.user.display_name[0].toUpperCase()}
            </span>
          </div>
        </header>
        <main>
          <AlarmCleanupWarning />
          <div className="page-heading">
            <div>
              <h1>{t(page[0].toUpperCase() + page.slice(1))}</h1>
              {page === "overview" && homeView === "reminders" && (
                <p>
                  {t("{count} open", { count: items.length })}
                  {overdue.length > 0
                    ? ` · ${t("{count} overdue", { count: overdue.length })}`
                    : ""}
                </p>
              )}
            </div>
            {((page === "overview" && homeView === "reminders") ||
              page === "calendar") && (
              <button className="primary add-item" onClick={() => newItem()}>
                <Plus size={20} />
                {t("Add item")}
              </button>
            )}
          </div>
          {page === "overview" && (
            <div
              className="segmented home-switch"
              aria-label={t("Home content")}
            >
              <button
                className={homeView === "reminders" ? "active" : ""}
                aria-pressed={homeView === "reminders"}
                disabled={parsing}
                onClick={() => setHomeView("reminders")}
              >
                {t("Reminders")}
              </button>
              <button
                className={homeView === "notes" ? "active" : ""}
                aria-pressed={homeView === "notes"}
                disabled={parsing}
                onClick={() => setHomeView("notes")}
              >
                {t("Notes")}
              </button>
            </div>
          )}
          {error && (
            <div className="error global-error" role="alert">
              {messageText(error)}
              <button
                className="icon-button"
                aria-label={t("Dismiss error")}
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {page === "overview" && homeView === "notes" && (
            <Notes
              blocked={!!draft || !!selected}
              onReminder={(note) => {
                setEditId(undefined);
                setDraft({
                  ...manualDraft("dated_item"),
                  title: note.title,
                  due_date: null,
                  due_time: null,
                  uncertain: ["due_date", "due_time"],
                  warnings: [
                    "Your note stays unchanged. Choose when to be reminded, then confirm.",
                  ],
                });
              }}
            />
          )}
          {page === "overview" && homeView === "reminders" && (
            <>
              <section
                className={`capture-card ${dragging ? "dragging" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void importFile(e.dataTransfer.files[0]);
                }}
              >
                <div className="capture-heading">
                  <h2>{t("Add a reminder")}</h2>
                </div>
                <div className="capture-input">
                  <textarea
                    ref={capture}
                    rows={3}
                    maxLength={4000}
                    aria-label={t("Natural language input")}
                    readOnly={voiceBusy}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t("e.g. Dentist tomorrow at 9am")}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void parseInput();
                      }
                    }}
                  />
                  <button
                    className="parse-button"
                    disabled={!text.trim() || parsing || voiceBusy}
                    aria-label={t("Preview draft")}
                    onClick={() => void parseInput()}
                  >
                    {parsing ? (
                      <span className="spinner" />
                    ) : (
                      <ArrowRight size={21} />
                    )}
                  </button>
                </div>
                <VoiceInput
                  disabled={parsing || !!draft || !!selected}
                  aiEnabled={!!modelSettings?.enabled}
                  onBusy={setVoiceBusy}
                  onReset={() => {
                    setText("");
                    setImportError("");
                    capture.current?.blur();
                    capture.current
                      ?.closest(".capture-card")
                      ?.scrollIntoView({ block: "start" });
                  }}
                  onText={setText}
                >
                  <button
                    disabled={parsing || voiceBusy}
                    onClick={() => file.current?.click()}
                  >
                    <Upload size={15} />
                    {t("Import reminder")}
                  </button>
                </VoiceInput>
                <p className="small muted">
                  {t("PDF or image: bills, appointments, and dated notices.")}
                </p>
                {modelSettings?.enabled && (
                  <p className="small muted">
                    {t(
                      "AI-first capture. Local parsing takes over if your models are unavailable.",
                    )}
                  </p>
                )}
                {modelSettings?.available &&
                  modelSettings.enabled &&
                  modelSettings.allow_images && (
                    <label className="ai-toggle">
                      <input
                        type="checkbox"
                        checked={imageAI}
                        disabled={parsing}
                        onChange={(event) => setImageAI(event.target.checked)}
                      />
                      <span>
                        {t(
                          (modelSettings.models?.length ?? 1) > 1
                            ? "Send document images to my configured AI models for this import"
                            : "Send document images to my AI provider for this import",
                        )}
                        <small className="image-model-chain">
                          {t(
                            "AI already reads extracted text. This also shares the images.",
                          )}
                        </small>
                        {(modelSettings.models?.length ?? 0) > 1 && (
                          <small className="image-model-chain">
                            {t("Tried in order: {models}", {
                              models: modelSettings
                                .models!.map(
                                  (model) =>
                                    `${model.provider} / ${model.model}`,
                                )
                                .join(" → "),
                            })}
                          </small>
                        )}
                      </span>
                    </label>
                  )}
                {parsing && (
                  <p className="small muted" role="status">
                    {t(
                      "Preparing your draft. Scanned files may take a moment…",
                    )}
                  </p>
                )}
                {importError && (
                  <div className="import-error" role="alert">
                    <span>{messageText(importError)}</span>
                    <button className="text-button" onClick={() => newItem()}>
                      {t("Enter manually")}
                      <ArrowRight size={15} />
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
          {page === "calendar" && (
            <div className="full-calendar">
              {calendar}
              {day && (
                <button className="text-button" onClick={() => setDay(null)}>
                  {t("Show all dates")}
                </button>
              )}
            </div>
          )}
          {((page === "overview" && homeView === "reminders") ||
            page === "calendar" ||
            page === "history") && (
            <div className="content-grid">
              <section className="list-panel" id="items-list">
                <div className="section-heading">
                  <h2>
                    {page === "history"
                      ? t("Your history")
                      : page === "calendar" && day
                        ? new Date(`${day}T12:00:00`).toLocaleDateString(
                            getLocale(),
                            { month: "long", day: "numeric" },
                          )
                        : t("Your items")}
                    <span className="count">{visible.length}</span>
                  </h2>
                  <label className="search-box">
                    <Search size={16} />
                    <input
                      aria-label={t("Search items")}
                      value={search}
                      placeholder={t("Search items")}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                </div>
                <div className="list-filters">
                  <div className="tabs">
                    {(
                      ["all", "bill", "appointment", "dated_item"] as const
                    ).map((f) => (
                      <button
                        key={f}
                        className={filter === f ? "active" : ""}
                        onClick={() => setFilter(f)}
                      >
                        {f === "all"
                          ? t("All items")
                          : f === "bill"
                            ? t("Bills")
                            : f === "appointment"
                              ? t("Appointments")
                              : t("Other")}
                      </button>
                    ))}
                  </div>
                  <span className="sort-label">
                    {page === "history" ? t("Latest first") : t("Due date")}
                  </span>
                </div>
                {loading ? (
                  <div className="empty-state">
                    <span className="spinner dark" />
                    <p>{t("Loading your items…")}</p>
                  </div>
                ) : visible.length ? (
                  <div className="item-list">
                    {visible.map((item, index) => {
                      const Icon = icons[item.kind];
                      const late =
                        item.status === "open" &&
                        new Date(item.due_at).getTime() < clock;
                      const previousLate =
                        index > 0 &&
                        new Date(visible[index - 1].due_at).getTime() < clock;
                      return (
                        <div key={item.id}>
                          {page !== "history" &&
                            (index === 0 || previousLate !== late) && (
                              <div
                                className={`group-label ${late ? "late" : ""}`}
                              >
                                {late ? t("Overdue") : t("Upcoming")}
                              </div>
                            )}
                          <article className="item-row">
                            <button
                              className="item-main"
                              onClick={() => setSelected(item)}
                            >
                              <span className={`type-icon ${item.kind}`}>
                                <Icon size={21} />
                              </span>
                              <span className="item-text">
                                <strong>{item.title}</strong>
                                {item.urgent && (
                                  <small className="urgent-badge">
                                    {t("Urgent")}
                                  </small>
                                )}
                                <span className={late ? "late-text" : ""}>
                                  {new Date(item.due_at).toLocaleDateString(
                                    getLocale(),
                                    {
                                      timeZone: item.timezone,
                                      month: "short",
                                      day: "numeric",
                                    },
                                  )}{" "}
                                  · {item.due_time}
                                  {late ? ` · ${t("Overdue")}` : ""}
                                </span>
                              </span>
                              <span className="item-amount">{money(item)}</span>
                            </button>
                            {item.status === "open" ? (
                              <button
                                className="complete-button"
                                aria-label={
                                  item.kind === "bill"
                                    ? t("Mark {title} as paid", {
                                        title: item.title,
                                      })
                                    : t("Complete {title}", {
                                        title: item.title,
                                      })
                                }
                                disabled={working === item.id}
                                onClick={() =>
                                  void changeState(item).catch(() => {})
                                }
                              >
                                <Check size={17} />
                                <span>
                                  {item.kind === "bill" ? t("Paid") : t("Done")}
                                </span>
                              </button>
                            ) : (
                              <span className="status-pill sent">
                                <Check size={12} />
                                {t(item.status)}
                              </span>
                            )}
                          </article>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state">
                    <span className="empty-symbol">
                      {search ? (
                        <Search size={29} />
                      ) : page === "history" ? (
                        <CheckCheck size={31} />
                      ) : (
                        <Check size={31} />
                      )}
                    </span>
                    <h3>
                      {search
                        ? t("No matching items")
                        : page === "history"
                          ? t("No finished items")
                          : day
                            ? t("Nothing scheduled")
                            : t("No open items")}
                    </h3>
                    <p>
                      {search
                        ? t("Try another search or filter.")
                        : page === "history"
                          ? t("Paid and completed items appear here.")
                          : day
                            ? t("Choose another day or add an item.")
                            : t("Add a bill, appointment, or reminder.")}
                    </p>
                    {page !== "history" && !search && (
                      <button className="text-button" onClick={() => newItem()}>
                        <Plus size={15} />
                        {t("Add your first item")}
                      </button>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}
          {page === "notifications" && (
            <div className="settings-grid">
              <UrgentAlarmSettings onEnabled={refresh} />
              <section className="settings-card">
                <h2>{t("Remind me on this device")}</h2>
                <p className="muted">
                  {t("Notifications show titles and times, never amounts.")}
                </p>
                <button
                  className="primary"
                  disabled={pushBusy}
                  onClick={() => void enablePush()}
                >
                  <Bell size={16} />
                  {pushBusy ? t("Connecting…") : t("Enable on this device")}
                </button>
                <h3 className="device-title">{t("Your devices")}</h3>
                {!devices.length && (
                  <p className="empty-inline">
                    {t("No devices connected yet.")}
                  </p>
                )}
                {devices.map((d) => (
                  <div className="delivery-row" key={d.id}>
                    <div>
                      <strong>
                        {d.platform === "ios" ? "iPhone" : t("Web browser")}
                      </strong>
                      <small>
                        {t("Device {id}", { id: d.id.slice(0, 8) })}
                      </small>
                    </div>
                    <span
                      className={`status-pill ${d.active ? "sent" : "cancelled"}`}
                    >
                      {d.active ? t("Connected") : t("Disabled")}
                    </span>
                    {d.active && (
                      <button
                        className="text-button"
                        onClick={() =>
                          void api(`/devices/${d.id}`, { method: "DELETE" })
                            .then(refresh)
                            .catch((e) => setError(e.message))
                        }
                      >
                        {t("Disable")}
                      </button>
                    )}
                  </div>
                ))}
                <details className="disclosure">
                  <summary>{t("How reminders work")}</summary>
                  <p>
                    {t(
                      "Enable each device separately. Open an item to check delivery status.",
                    )}
                  </p>
                  <p>
                    {t(
                      "We check every minute and retry failed sends. Sent means the push service accepted a reminder, not that it was displayed.",
                    )}
                  </p>
                </details>
              </section>
            </div>
          )}
          {page === "settings" && (
            <AccountSettings
              account={account}
              onModelChange={(value) => {
                setModelSettings(value);
                setImageAI(false);
              }}
            />
          )}
          {page === "settings" && (
            <details className="settings-card disclosure privacy-settings">
              <summary>{t("Privacy & preferences")}</summary>
              <div className="setting-line">
                <strong>{t("Time zone")}</strong>
                <span>{context().timezone}</span>
              </div>
              <p className="muted">
                {t(
                  "New items use this device's time zone. You can change it per item.",
                )}
              </p>
              <div className="setting-line">
                <strong>{t("Files")}</strong>
                <span>{t("Discarded after parsing")}</span>
              </div>
              <p className="muted">
                {t("Only the last 4 account digits are stored.")}
              </p>
              <div className="setting-line">
                <strong>{t("Voice input")}</strong>
                <span>{t("System speech recognition")}</span>
              </div>
              <p className="muted">
                {t(
                  "System speech may process audio online. Mewmo does not store recordings.",
                )}
              </p>
            </details>
          )}
          {page === "settings" && (
            <button
              className="secondary signout-settings"
              onClick={() => void onSignOut().catch((e) => setError(e.message))}
            >
              <LogOut size={16} />
              {t("Sign out")}
            </button>
          )}
        </main>
      </div>
      <input
        ref={file}
        hidden
        type="file"
        accept="application/pdf,image/*"
        onChange={(e) => void importFile(e.target.files?.[0])}
      />
      <nav className="mobile-nav" aria-label={t("Mobile navigation")}>
        {navigation.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={page === key ? "active" : ""}
            aria-label={label}
            aria-current={page === key ? "page" : undefined}
            onClick={() => navigate(key)}
          >
            <Icon size={20} />
            <span>
              {key === "overview"
                ? t("Home")
                : key === "notifications"
                  ? t("Alerts")
                  : label}
            </span>
          </button>
        ))}
        <button
          onClick={() => navigate("settings")}
          className={page === "settings" ? "active" : ""}
        >
          <Settings2 size={20} />
          <span>{t("Settings")}</span>
        </button>
      </nav>
      {draft && (
        <Editor
          draft={draft}
          itemId={editId}
          onClose={() => {
            setDraft(null);
            setEditId(undefined);
          }}
          onSaved={(item) => {
            setDraft(null);
            if (item.urgent) setSelected(item);
            setEditId(undefined);
            setText("");
            setToast({
              message: editId ? t("Changes saved.") : t("Item saved."),
            });
            void refresh().catch((e) => setError(e.message));
          }}
        />
      )}
      {selected && (
        <ItemDetail
          key={selected.id}
          item={selected}
          onUpdated={setSelected}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditId(selected.id);
            setDraft({
              ...selected,
              source: "manual",
              uncertain: [],
              warnings: [],
              duplicates: [],
            });
            setSelected(null);
          }}
          onState={changeState}
          onDelete={async () => {
            const epoch = alarmEpoch();
            await api(`/items/${selected.id}`, { method: "DELETE" });
            await syncAlarms([{ ...selected, urgent: false }], {
              expectedEpoch: epoch,
            }).catch(() => {});
            setSelected(null);
            setToast({
              message: t("Item deleted. Unsent reminders cancelled."),
            });
            await refresh();
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{messageText(toast.message)}</span>
          {toast.undo && (
            <button
              disabled={!!working}
              onClick={() =>
                void changeState(toast.undo!, true).catch(() => {})
              }
            >
              {t("Undo")}
            </button>
          )}
          <button
            className="icon-button"
            aria-label={t("Dismiss notification")}
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
