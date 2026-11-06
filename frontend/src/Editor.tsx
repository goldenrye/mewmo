import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  CalendarDays,
  Check,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import {
  context,
  defaults,
  fullDate,
  kindName,
  type Draft,
  type Item,
  type Kind,
  type Rule,
} from "./types";

export function Editor({
  draft,
  itemId,
  onClose,
  onSaved,
}: {
  draft: Draft;
  itemId?: string;
  onClose: () => void;
  onSaved: (item: Item) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState<Draft>(draft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [duplicateAccepted, setDuplicateAccepted] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function field<K extends keyof Draft>(key: K, next: Draft[K]) {
    setValue((old) => ({
      ...old,
      [key]: next,
      uncertain: old.uncertain.filter((f) => f !== key),
    }));
  }
  function rule(index: number, patch: Partial<Rule>) {
    field(
      "rules",
      value.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }
  const label = (key: string, text: string) => (
    <span>
      {text}
      {value.uncertain.includes(key) && (
        <small className="review-flag">Check this</small>
      )}
    </span>
  );
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const item = await api<Item>(itemId ? `/items/${itemId}` : "/items", {
        method: itemId ? "PUT" : "POST",
        body: JSON.stringify({
          ...value,
          ...context(),
          timezone: value.timezone,
          confirmed: true,
          payee: value.payee || null,
          amount: value.amount === "" ? null : value.amount,
          currency: value.currency || null,
          account_last4: value.account_last4 || null,
        }),
      });
      onSaved(item);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="editor-dialog"
      ref={dialog}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <form onSubmit={save}>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">
              {itemId ? "MAKE IT YOURS" : "ONE QUICK CHECK"}
            </span>
            <h2>{itemId ? "Edit your item" : "Does this look right?"}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close editor"
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>
        {!itemId && (
          <p className="muted">
            This is a draft. Nothing is saved until you confirm.
          </p>
        )}
        {value.warnings.map((w, i) => (
          <div className="notice" key={i}>
            <AlertCircle size={17} />
            <span>{w}</span>
          </div>
        ))}
        <div className="segmented kind-switch">
          {(["bill", "appointment", "dated_item"] as Kind[]).map((kind) => (
            <button
              type="button"
              key={kind}
              className={value.kind === kind ? "active" : ""}
              onClick={() =>
                setValue((v) => ({
                  ...v,
                  kind,
                  rules: defaults(kind),
                  status: "open",
                }))
              }
            >
              {kindName[kind]}
            </button>
          ))}
        </div>
        <label>
          {label("title", "Title")}
          <input
            autoFocus
            required
            maxLength={180}
            value={value.title}
            onChange={(e) => field("title", e.target.value)}
            placeholder="Give it a name"
          />
        </label>
        {value.kind === "bill" && (
          <>
            <label>
              {label("payee", "Payee")}
              <input
                required
                maxLength={180}
                value={value.payee || ""}
                onChange={(e) => field("payee", e.target.value)}
                placeholder="Who is this bill from?"
              />
            </label>
            <div className="form-grid">
              <label>
                {label("amount", "Amount")}
                <input
                  required
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="999999999999.99"
                  step=".01"
                  value={value.amount ?? ""}
                  onChange={(e) => field("amount", e.target.value)}
                />
              </label>
              <label>
                {label("currency", "Currency")}
                <input
                  required
                  pattern="[A-Z]{3}"
                  maxLength={3}
                  value={value.currency || ""}
                  onChange={(e) =>
                    field("currency", e.target.value.toUpperCase())
                  }
                  placeholder="USD"
                  list="currencies"
                />
                <datalist id="currencies">
                  {["USD", "CAD", "AUD", "CNY", "EUR", "GBP", "HKD", "JPY"].map(
                    (c) => (
                      <option key={c}>{c}</option>
                    ),
                  )}
                </datalist>
              </label>
            </div>
            <label>
              Account ending in{" "}
              <span className="optional">(optional, last 4 only)</span>
              <input
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                value={value.account_last4 || ""}
                onChange={(e) => field("account_last4", e.target.value)}
                placeholder="1234"
              />
            </label>
          </>
        )}
        <div className="form-grid">
          <label>
            {label("due_date", value.kind === "bill" ? "Due date" : "Date")}
            <input
              required
              type="date"
              value={value.due_date || ""}
              onChange={(e) => field("due_date", e.target.value)}
            />
          </label>
          <label>
            {label("due_time", "Time")}
            <input
              required
              type="time"
              value={value.due_time || ""}
              onChange={(e) => field("due_time", e.target.value)}
            />
          </label>
        </div>
        <label>
          Time zone
          <input
            required
            value={value.timezone}
            onChange={(e) => field("timezone", e.target.value)}
          />
        </label>
        <div className="date-preview">
          <CalendarDays size={19} />
          <div>
            <strong>{fullDate(value.due_date, value.due_time)}</strong>
            <span>{value.timezone}</span>
          </div>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={value.status !== "open"}
            onChange={(e) =>
              field(
                "status",
                e.target.checked
                  ? value.kind === "bill"
                    ? "paid"
                    : "completed"
                  : "open",
              )
            }
          />
          {value.kind === "bill" ? "Already paid" : "Already completed"}
          <span className="muted">No reminders while finished</span>
        </label>
        <section className="rules">
          <div className="section-heading">
            <h3>
              <Bell size={16} /> Reminders
            </h3>
            <button
              type="button"
              className="text-button"
              onClick={() => field("rules", defaults(value.kind))}
            >
              Reset defaults
            </button>
          </div>
          <p className="muted small">
            Past reminder times are skipped. Amounts stay out of notifications.
          </p>
          {value.rules.map((r, i) => (
            <div className="rule-row" key={i}>
              <select
                aria-label={`Reminder ${i + 1} mode`}
                value={r.mode}
                onChange={(e) =>
                  rule(i, { mode: e.target.value as Rule["mode"] })
                }
              >
                <option value="before">Minutes before</option>
                <option value="day">Calendar day offset</option>
              </select>
              <input
                aria-label={`Reminder ${i + 1} offset`}
                type="number"
                min={r.mode === "before" ? 0 : -365}
                max={r.mode === "before" ? 525600 : 365}
                required
                value={r.mode === "before" ? r.minutes : r.days}
                onChange={(e) =>
                  rule(i, {
                    [r.mode === "before" ? "minutes" : "days"]: Number(
                      e.target.value,
                    ),
                  })
                }
              />
              {r.mode === "day" && (
                <input
                  type="time"
                  aria-label={`Reminder ${i + 1} time`}
                  required
                  value={r.at}
                  onChange={(e) => rule(i, { at: e.target.value })}
                />
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove reminder ${i + 1}`}
                onClick={() =>
                  field(
                    "rules",
                    value.rules.filter((_, index) => index !== i),
                  )
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <p className="muted small">
            Day offsets: −1 is the day before, 0 is the due date, +1 is the day
            after.
          </p>
          <button
            type="button"
            disabled={value.rules.length >= 20}
            className="text-button"
            onClick={() =>
              field("rules", [
                ...value.rules,
                { mode: "before", minutes: 30, days: 0, at: "09:00" },
              ])
            }
          >
            <Plus size={15} /> Add reminder
          </button>
        </section>
        {!!value.duplicates.length && (
          <label className="checkbox-label notice">
            <input
              required
              type="checkbox"
              checked={duplicateAccepted}
              onChange={(e) => setDuplicateAccepted(e.target.checked)}
            />
            I reviewed the duplicate warning and want to save this bill.
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <span>
            <ShieldCheck size={15} /> Just for you
          </span>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Saving…" : itemId ? "Save changes" : "Confirm & save"}
            <Check size={17} />
          </button>
        </div>
      </form>
    </dialog>
  );
}
