import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import {
  ArrowRight,
  ArrowUpRight,
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
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { api, setToken } from "./api";
import { Editor } from "./Editor";
import { enableNotifications } from "./notifications";
import {
  context,
  fullDate,
  kindName,
  manualDraft,
  money,
  type Device,
  type Draft,
  type Item,
  type Kind,
  type Reminder,
} from "./types";

type Page = "overview" | "calendar" | "history" | "notifications" | "settings";
const icons = { bill: FileText, appointment: CalendarDays, dated_item: Clock3 };

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <path d="M6 24V10a3 3 0 0 1 5-2l5 8 5-8a3 3 0 0 1 5 2v14" />
        </svg>
      </span>
      <span>
        mewmo<span className="brand-dot">.</span>
      </span>
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: string | null }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setToken(result.token);
      onLogin();
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
        <div>
          <span className="eyebrow">YOUR PERSONAL PEACE OF MIND</span>
          <h1>
            Life has a lot
            <br />
            of little things.
            <br />
            <em>Let them go here.</em>
          </h1>
          <p>
            Bills, appointments, and the things you don’t want to forget. One
            quiet place to keep them all.
          </p>
        </div>
        <div className="login-loop">
          <span>
            <Plus size={16} /> Capture
          </span>
          <ArrowRight size={16} />
          <span>
            <Check size={16} /> Confirm
          </span>
          <ArrowRight size={16} />
          <span>
            <Bell size={16} /> Remember
          </span>
        </div>
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <span className="welcome-icon">
            <ShieldCheck size={28} />
          </span>
          <span className="eyebrow">A SPACE THAT’S JUST YOURS</span>
          <h2>Welcome to Mewmo</h2>
          <p className="muted">Sign in to take a little off your mind.</p>
          <label>
            Your password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Come on in"}
            <ArrowRight size={18} />
          </button>
          <p className="login-footnote">
            <ShieldCheck size={14} /> Private by design. Only you have access.
          </p>
        </form>
      </div>
    </div>
  );
}

function ItemDetail({
  item,
  onClose,
  onEdit,
  onState,
  onDelete,
}: {
  item: Item;
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
          aria-label="Close details"
          className="icon-button"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <span className="eyebrow">
        {kindName[item.kind]} · {item.status}
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
          Payee: {item.payee}
          {item.account_last4 && ` · Account ending ${item.account_last4}`}
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
            ? "Reopen item"
            : item.kind === "bill"
              ? "Mark as paid"
              : "Mark complete"}
        </button>
        <button className="secondary" onClick={onEdit}>
          Edit item
        </button>
      </div>
      <section className="delivery-list">
        <div className="section-heading">
          <h3>
            <Bell size={17} /> Reminder delivery
          </h3>
          <span className="muted small">Refreshes every 15s</span>
        </div>
        <p className="muted small">
          “Sent” means accepted by the push service, not necessarily read or
          displayed on your device.
        </p>
        {loading && <p className="muted">Loading reminder status…</p>}
        {!loading && !reminders.length && (
          <p className="empty-inline">
            No future reminders were scheduled. Past times are skipped.
          </p>
        )}
        {reminders.map((r) => (
          <div className="delivery-row" key={r.id}>
            <div>
              <strong>
                {new Date(r.fire_at).toLocaleString("en-US", {
                  timeZone: item.timezone,
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </strong>
              <small>
                {r.attempts} delivery attempt{r.attempts === 1 ? "" : "s"}
                {r.error && ` · ${r.error.replaceAll("_", " ")}`}
              </small>
              {r.deliveries.map((d, i) => (
                <small key={i}>
                  {d.platform === "ios" ? "iPhone" : "Web"}: {d.status}
                  {d.error && ` (${d.error.replaceAll("_", " ")})`}
                </small>
              ))}
            </div>
            <span className={`status-pill ${r.status}`}>{r.status}</span>
          </div>
        ))}
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="delete-section">
        {confirmDelete ? (
          <>
            <p>Delete this item and cancel its unsent reminders?</p>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void action(onDelete)}
            >
              Yes, delete item
            </button>
            <button
              className="text-button"
              onClick={() => setConfirmDelete(false)}
            >
              Keep item
            </button>
          </>
        ) : (
          <button
            className="text-button danger"
            onClick={() => setConfirmDelete(true)}
          >
            Delete item
          </button>
        )}
      </div>
    </dialog>
  );
}

export default function App() {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [page, setPage] = useState<Page>("overview");
  const [items, setItems] = useState<Item[]>([]);
  const [finished, setFinished] = useState<Item[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [vapid, setVapid] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [importError, setImportError] = useState("");
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
  const today = context().local_date;
  const refresh = useCallback(async () => {
    const [open, history, registered] = await Promise.all([
      api<Item[]>("/items"),
      api<Item[]>("/items?history=true"),
      api<Device[]>("/devices"),
    ]);
    setItems(open);
    setFinished(history);
    setDevices(registered);
  }, []);
  useEffect(() => {
    api<{ vapid_public_key: string }>("/auth/me")
      .then((me) => {
        setVapid(me.vapid_public_key);
        setAuth("in");
      })
      .catch(() => setAuth("out"));
    const logout = () => {
      setAuth("out");
      setToken(null);
      setItems([]);
      setFinished([]);
      setDraft(null);
      setSelected(null);
      setText("");
      setDevices([]);
      setToast(null);
    };
    window.addEventListener("mewmo:unauthorized", logout);
    return () => window.removeEventListener("mewmo:unauthorized", logout);
  }, []);
  useEffect(() => {
    if (auth !== "in") return;
    setLoading(true);
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    void api<{ vapid_public_key: string }>("/auth/me")
      .then((me) => setVapid(me.vapid_public_key))
      .catch((e) => setError(e.message));
    const timer = setInterval(() => {
      setClock(Date.now());
      void refresh().catch((e) => setError(e.message));
    }, 60000);
    return () => clearInterval(timer);
  }, [auth, refresh]);
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
    if (!text.trim() || parsing) return;
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
    if (!value || parsing) return;
    if (value.size > 12 * 1024 * 1024) {
      setImportError("Please choose a file smaller than 12 MB.");
      return;
    }
    setParsing(true);
    setImportError("");
    try {
      const query = new URLSearchParams(context());
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
      if (file.current) file.current.value = "";
    }
  }
  async function changeState(item: Item, undo = false) {
    setWorking(item.id);
    setError("");
    try {
      await api(`/items/${item.id}/state`, {
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
      setSelected(null);
      setToast({
        message:
          undo || item.status !== "open"
            ? "Item reopened. Future reminders restored."
            : item.kind === "bill"
              ? "Bill marked as paid. One less thing."
              : "All done. Reminders stopped.",
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
      setToast({ message: "Notifications enabled on this device." });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPushBusy(false);
    }
  }
  const overdue = items.filter((i) => new Date(i.due_at).getTime() < clock);
  const nextWeek = items.filter(
    (i) =>
      new Date(i.due_at).getTime() >= clock &&
      new Date(i.due_at).getTime() < clock + 7 * 86400000,
  );
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
    { key: "overview", label: "Overview", icon: LayoutDashboard },
    { key: "calendar", label: "Calendar", icon: CalendarDays },
    { key: "history", label: "History", icon: History },
    { key: "notifications", label: "Notifications", icon: Bell },
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
          {month.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })}
        </h3>
        <div className="calendar-arrows">
          <button
            className="icon-button"
            aria-label="Previous month"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
            }
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Next month"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
            }
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="calendar-grid">
        {["S", "M", "T", "W", "T", "F", "S"].map((s, i) => (
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
              aria-label={`${d.toDateString()}, ${count} items`}
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
        <i /> Items to remember
      </div>
    </div>
  );

  if (auth === "loading")
    return (
      <div className="loading-page">
        <Brand />
        <p>Making a little space…</p>
      </div>
    );
  if (auth === "out") return <Login onLogin={() => setAuth("in")} />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">YOUR PERSONAL SPACE</div>
        <nav>
          {navigation.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={page === key ? "active" : ""}
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
        <div className="sidebar-note">
          <span className="note-art">
            <CheckCheck size={30} />
          </span>
          <h3>A little less to carry.</h3>
          <p>
            You remember to live.
            <br />
            Mewmo remembers the rest.
          </p>
        </div>
        <div className="sidebar-bottom">
          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} /> Settings
          </button>
          <div className="profile">
            <span>Y</span>
            <div>
              <strong>Your space</strong>
              <small>Personal account</small>
            </div>
            <button
              aria-label="Sign out"
              className="icon-button"
              onClick={() =>
                void api("/auth/logout", { method: "POST" })
                  .then(() => {
                    window.dispatchEvent(new Event("mewmo:unauthorized"));
                  })
                  .catch((e) => setError(e.message))
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            My space <ChevronRight size={13} />
            <strong>{page[0].toUpperCase() + page.slice(1)}</strong>
          </div>
          <div className="topbar-right">
            <span className="today-label">
              <CalendarDays size={15} />
              {new Date(clock).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            <button
              className="icon-button notification-button"
              aria-label="Open notifications"
              onClick={() => navigate("notifications")}
            >
              <Bell size={19} />
              {devices.some((d) => d.active) && <i />}
            </button>
            <span className="avatar">Y</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === "history"
                  ? "LOOK HOW FAR YOU’VE COME"
                  : "A CLEARER HEAD STARTS HERE"}
              </span>
              <h1>
                {page === "overview"
                  ? "A little less on your mind."
                  : page === "calendar"
                    ? "Make room for what’s next."
                    : page === "history"
                      ? "Taken care of."
                      : page === "notifications"
                        ? "A timely little nudge."
                        : "Your space, your way."}
              </h1>
              <p>
                {page === "overview"
                  ? "Keep life’s little to-dos in one calm place."
                  : page === "history"
                    ? "Your finished bills, appointments, and reminders."
                    : page === "calendar"
                      ? "The days ahead, with nothing slipping through."
                      : page === "notifications"
                        ? "Choose where Mewmo reminds you. Your amounts stay private."
                        : "Simple settings for your personal Mewmo."}
              </p>
            </div>
            <button className="primary add-item" onClick={() => newItem()}>
              <Plus size={17} />
              Add item
            </button>
          </div>
          {error && (
            <div className="error global-error" role="alert">
              {error}
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {page === "overview" && (
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
                  <span>
                    <Sparkles size={20} />
                  </span>
                  <div>
                    <h2>What’s on your mind?</h2>
                    <p>
                      Type it, drop in a bill, or use your keyboard’s dictation.
                    </p>
                  </div>
                  <span className="draft-badge">
                    <ShieldCheck size={13} /> You’re always in control
                  </span>
                </div>
                <div className="capture-input">
                  <textarea
                    ref={capture}
                    rows={1}
                    aria-label="Natural language input"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="e.g. Dentist next Friday at 10am, or 这个月水电 120 刀，已付"
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
                    disabled={!text.trim() || parsing}
                    aria-label="Preview draft"
                    onClick={() => void parseInput()}
                  >
                    {parsing ? (
                      <span className="spinner" />
                    ) : (
                      <ArrowRight size={21} />
                    )}
                  </button>
                </div>
                <div className="capture-footer">
                  <div>
                    <button
                      disabled={parsing}
                      onClick={() => file.current?.click()}
                    >
                      <Upload size={15} />
                      Import a bill
                    </button>
                    <span className="divider" />
                    <span>PDF, image, or photo</span>
                  </div>
                  <span>
                    Nothing saved until you confirm <Check size={14} />
                  </span>
                </div>
                {parsing && (
                  <p className="small muted" role="status">
                    Preparing your draft. Scanned files may take a moment…
                  </p>
                )}
                {importError && (
                  <div className="import-error" role="alert">
                    <span>{importError}</span>
                    <button className="text-button" onClick={() => newItem()}>
                      Enter manually <ArrowRight size={15} />
                    </button>
                  </div>
                )}
              </section>
              <div className="stats-grid">
                <button
                  className="stat-card"
                  onClick={() => {
                    setFilter("all");
                    document
                      .getElementById("items-list")
                      ?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  <span className="stat-label">
                    Open items <LayoutDashboard size={16} />
                  </span>
                  <strong>{items.length.toString().padStart(2, "0")}</strong>
                  <span>Little things on your list</span>
                </button>
                <button
                  className="stat-card"
                  onClick={() => {
                    setFilter("all");
                    document
                      .getElementById("items-list")
                      ?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  <span className="stat-label">
                    Coming up <CalendarDays size={16} />
                  </span>
                  <strong>
                    {nextWeek.length.toString().padStart(2, "0")}
                    <small>this week</small>
                  </strong>
                  <span>In the next 7 days</span>
                </button>
                <button
                  className={`stat-card ${overdue.length ? "has-overdue" : ""}`}
                  onClick={() => {
                    setFilter("all");
                    document
                      .getElementById("items-list")
                      ?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  <span className="stat-label">
                    Needs attention <Clock3 size={16} />
                  </span>
                  <strong>{overdue.length.toString().padStart(2, "0")}</strong>
                  <span>
                    {overdue.length
                      ? "A gentle nudge to catch up"
                      : "Nothing overdue. Breathe easy."}
                  </span>
                </button>
              </div>
            </>
          )}
          {page === "calendar" && (
            <div className="full-calendar">
              {calendar}
              {day && (
                <button className="text-button" onClick={() => setDay(null)}>
                  Show all dates
                </button>
              )}
            </div>
          )}
          {(page === "overview" ||
            page === "calendar" ||
            page === "history") && (
            <div className="content-grid">
              <section className="list-panel" id="items-list">
                <div className="section-heading">
                  <h2>
                    {page === "history"
                      ? "Your history"
                      : page === "calendar" && day
                        ? new Date(`${day}T12:00:00`).toLocaleDateString(
                            "en-US",
                            { month: "long", day: "numeric" },
                          )
                        : "On your radar"}
                    <span className="count">{visible.length}</span>
                  </h2>
                  <label className="search-box">
                    <Search size={16} />
                    <input
                      aria-label="Search items"
                      value={search}
                      placeholder="Search items"
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
                          ? "All items"
                          : f === "bill"
                            ? "Bills"
                            : f === "appointment"
                              ? "Appointments"
                              : "Other"}
                      </button>
                    ))}
                  </div>
                  <span className="sort-label">
                    {page === "history" ? "Recently finished" : "By due date"}
                  </span>
                </div>
                {loading ? (
                  <div className="empty-state">
                    <span className="spinner dark" />
                    <p>Loading your items…</p>
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
                                {late
                                  ? "NEEDS A LITTLE ATTENTION"
                                  : "COMING UP"}
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
                                <span className={late ? "late-text" : ""}>
                                  {new Date(item.due_at).toLocaleDateString(
                                    "en-US",
                                    {
                                      timeZone: item.timezone,
                                      month: "short",
                                      day: "numeric",
                                    },
                                  )}{" "}
                                  · {item.due_time}
                                  {late
                                    ? " · Overdue"
                                    : ` · ${kindName[item.kind]}`}
                                </span>
                              </span>
                              <span className="item-amount">{money(item)}</span>
                            </button>
                            {item.status === "open" ? (
                              <button
                                className="complete-button"
                                aria-label={
                                  item.kind === "bill"
                                    ? `Mark ${item.title} as paid`
                                    : `Complete ${item.title}`
                                }
                                disabled={working === item.id}
                                onClick={() =>
                                  void changeState(item).catch(() => {})
                                }
                              >
                                <Check size={17} />
                                <span>
                                  {item.kind === "bill" ? "Paid" : "Done"}
                                </span>
                              </button>
                            ) : (
                              <span className="status-pill sent">
                                <Check size={12} />
                                {item.status}
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
                        ? "Nothing by that name."
                        : page === "history"
                          ? "Good things take a little time."
                          : day
                            ? "A little breathing room."
                            : "A clear list. A clearer head."}
                    </h3>
                    <p>
                      {search
                        ? "Try another word or a different filter."
                        : page === "history"
                          ? "Finished items will find their home right here."
                          : day
                            ? "There’s nothing scheduled for this day."
                            : "Add a bill, an appointment, or something to remember."}
                    </p>
                    {page !== "history" && !search && (
                      <button className="text-button" onClick={() => newItem()}>
                        <Plus size={15} />
                        Add your first item
                      </button>
                    )}
                  </div>
                )}
                <div className="list-bottom">
                  <ShieldCheck size={14} />
                  <span>
                    {page === "history"
                      ? "Reopen any item to restore its future reminders."
                      : "A small step today. One less thing tomorrow."}
                  </span>
                </div>
              </section>
              <aside className="right-rail">
                {page !== "calendar" && calendar}
                <div className="reminder-card">
                  <span className="rail-icon">
                    <Bell size={21} />
                  </span>
                  <h3>A nudge, not a worry.</h3>
                  <p>
                    {devices.some((d) => d.active)
                      ? "Your reminders are ready. Open any item to see its delivery status."
                      : "Enable notifications so the important things find you, right on time."}
                  </p>
                  <button
                    className="text-button"
                    disabled={pushBusy}
                    onClick={() =>
                      devices.some((d) => d.active)
                        ? navigate("notifications")
                        : void enablePush()
                    }
                  >
                    {pushBusy
                      ? "Connecting…"
                      : devices.some((d) => d.active)
                        ? "Notification settings"
                        : "Enable notifications"}
                    <ArrowUpRight size={16} />
                  </button>
                </div>
                <div className="privacy-note">
                  <ShieldCheck size={16} />
                  <span>
                    Your bills stay private.
                    <br />
                    Original files are never kept.
                  </span>
                </div>
              </aside>
            </div>
          )}
          {(page === "notifications" || page === "settings") && (
            <div className="settings-grid">
              <section className="settings-card">
                <span className="welcome-icon">
                  <Bell size={25} />
                </span>
                <h2>Never miss the little things.</h2>
                <p className="muted">
                  Enable notifications separately on each device you use. Every
                  reminder appears separately, with the title and time but never
                  the amount.
                </p>
                <button
                  className="primary"
                  disabled={pushBusy}
                  onClick={() => void enablePush()}
                >
                  <Bell size={16} />
                  {pushBusy ? "Connecting…" : "Enable on this device"}
                </button>
                <h3 className="device-title">Your devices</h3>
                {!devices.length && (
                  <p className="empty-inline">No devices connected yet.</p>
                )}
                {devices.map((d) => (
                  <div className="delivery-row" key={d.id}>
                    <div>
                      <strong>
                        {d.platform === "ios" ? "iPhone" : "Web browser"}
                      </strong>
                      <small>Device {d.id.slice(0, 8)}</small>
                    </div>
                    <span
                      className={`status-pill ${d.active ? "sent" : "cancelled"}`}
                    >
                      {d.active ? "Connected" : "Disabled"}
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
                        Disable
                      </button>
                    )}
                  </div>
                ))}
              </section>
              <section className="settings-card">
                <span className="welcome-icon">
                  <ShieldCheck size={25} />
                </span>
                <h2>Personal means private.</h2>
                <div className="setting-line">
                  <strong>Time zone</strong>
                  <span>{context().timezone}</span>
                </div>
                <p className="muted small">
                  Taken from this device with every capture. Each item keeps its
                  own time zone.
                </p>
                <div className="setting-line">
                  <strong>File storage</strong>
                  <span>Originals discarded</span>
                </div>
                <p className="muted small">
                  PDFs and images are parsed locally on your server. Only the
                  last 4 account digits can be stored.
                </p>
                <div className="setting-line">
                  <strong>Voice input</strong>
                  <span>Keyboard dictation</span>
                </div>
                <p className="muted small">
                  Use the dictation key on your iPhone keyboard. Mewmo doesn’t
                  access your microphone.
                </p>
                <div className="setting-line">
                  <strong>Delivery checks</strong>
                  <span>Every 60 seconds</span>
                </div>
                <p className="muted small">
                  Failed sends retry automatically. Open an item for its
                  per-reminder delivery status. Provider acceptance is not a
                  guarantee of display.
                </p>
              </section>
            </div>
          )}
          {page === "settings" && (
            <button
              className="secondary signout-settings"
              onClick={() =>
                void api("/auth/logout", { method: "POST" })
                  .then(() =>
                    window.dispatchEvent(new Event("mewmo:unauthorized")),
                  )
                  .catch((e) => setError(e.message))
              }
            >
              <LogOut size={16} /> Sign out
            </button>
          )}
          <footer className="page-footer">
            <span>Less mental clutter. More room for life.</span>
            <span>Made for your everyday.</span>
          </footer>
        </main>
      </div>
      <input
        ref={file}
        hidden
        type="file"
        accept="application/pdf,image/*"
        onChange={(e) => void importFile(e.target.files?.[0])}
      />
      <nav className="mobile-nav">
        {navigation.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={page === key ? "active" : ""}
            onClick={() => navigate(key)}
          >
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
        <button
          onClick={() => navigate("settings")}
          className={page === "settings" ? "active" : ""}
        >
          <Settings2 size={20} />
          <span>Settings</span>
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
          onSaved={() => {
            setDraft(null);
            setEditId(undefined);
            setText("");
            setToast({
              message: editId
                ? "Changes saved. Reminders updated."
                : "Saved. A little less on your mind.",
            });
            void refresh().catch((e) => setError(e.message));
          }}
        />
      )}
      {selected && (
        <ItemDetail
          key={selected.id}
          item={selected}
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
            await api(`/items/${selected.id}`, { method: "DELETE" });
            setSelected(null);
            setToast({ message: "Item deleted. Unsent reminders cancelled." });
            await refresh();
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              disabled={!!working}
              onClick={() =>
                void changeState(toast.undo!, true).catch(() => {})
              }
            >
              Undo
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
