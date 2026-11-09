import { messageText, t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  CalendarDays,
  Check,
  Plus,
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

const routineNotes = new Set([
  "AI suggested draft fields. Review them carefully; nothing has been saved.",
  "Review every field. OCR can make mistakes. The original file has been discarded.",
  "This AI request included bill images. Your provider may retain them.",
  "This AI request included document images. Your provider may retain them.",
]);

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
  const notes = [...new Set(value.warnings)].filter((warning) =>
    routineNotes.has(warning),
  );
  const warnings = [...new Set(value.warnings)].filter(
    (warning) => !routineNotes.has(warning),
  );
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
    <span className="field-label">
      {text}
      {value.uncertain.includes(key) && (
        <small className="review-flag">{t("Check this")}</small>
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
      <form
        onSubmit={save}
        onInvalidCapture={(event) => {
          const details = (event.target as HTMLElement).closest("details");
          if (details) details.open = true;
        }}
      >
        <div className="dialog-heading">
          <div>
            <h2>
              {itemId
                ? t("Edit item")
                : draft.source === "manual"
                  ? t("Add item")
                  : t("Review draft")}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Close editor")}
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>
        {!itemId && (
          <p className="muted">{t("Nothing is saved until you confirm.")}</p>
        )}
        {(draft.interpretation === "ai" ||
          notes.some((note) => note.startsWith("AI suggested"))) && (
          <p className="draft-source">{t("AI-assisted draft")}</p>
        )}
        {!itemId &&
          draft.source !== "manual" &&
          draft.interpretation === "local" && (
            <p className="draft-source">{t("Locally parsed draft")}</p>
          )}
        {warnings.map((w, i) => (
          <div className="notice" key={i}>
            <AlertCircle size={17} />
            <span>{messageText(w)}</span>
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
              {t(kindName[kind])}
            </button>
          ))}
        </div>
        <label>
          {label("title", t("Title"))}
          <input
            autoFocus
            required
            maxLength={180}
            value={value.title}
            onChange={(e) => field("title", e.target.value)}
            placeholder={t("Give it a name")}
          />
        </label>
        {value.kind === "bill" && (
          <>
            <label>
              {label("payee", t("Payee"))}
              <input
                required
                maxLength={180}
                value={value.payee || ""}
                onChange={(e) => field("payee", e.target.value)}
                placeholder={t("Who is this bill from?")}
              />
            </label>
            <div className="form-grid">
              <label>
                {label("amount", t("Amount"))}
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
                {label("currency", t("Currency"))}
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
              </label>
            </div>
            <datalist id="currencies">
              {["USD", "CAD", "AUD", "CNY", "EUR", "GBP", "HKD", "JPY"].map(
                (c) => (
                  <option key={c}>{c}</option>
                ),
              )}
            </datalist>
          </>
        )}
        <div className="form-grid date-fields">
          <label>
            {label(
              "due_date",
              value.kind === "bill" ? t("Due date") : t("Date"),
            )}
            <input
              required
              type="date"
              value={value.due_date || ""}
              onChange={(e) => field("due_date", e.target.value)}
            />
          </label>
          <label>
            {label("due_time", t("Time"))}
            <input
              required
              type="time"
              value={value.due_time || ""}
              onChange={(e) => field("due_time", e.target.value)}
            />
          </label>
        </div>
        <div className="date-preview">
          <CalendarDays size={19} />
          <div>
            <strong>{fullDate(value.due_date, value.due_time)}</strong>
            <span>{value.timezone}</span>
          </div>
        </div>
        <details
          className="disclosure"
          open={
            draft.uncertain.includes("timezone") ||
            draft.uncertain.includes("account_last4")
          }
        >
          <summary>
            {value.kind === "bill"
              ? t("Time zone & account details")
              : t("Change time zone")}
          </summary>
          <label>
            {label("timezone", t("Time zone"))}
            <input
              required
              value={value.timezone}
              onChange={(e) => field("timezone", e.target.value)}
            />
          </label>
          {value.kind === "bill" && (
            <label>
              {label("account_last4", t("Account last 4 digits (optional)"))}
              <input
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                value={value.account_last4 || ""}
                onChange={(e) => field("account_last4", e.target.value)}
                placeholder="1234"
              />
            </label>
          )}
        </details>
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
          {value.kind === "bill" ? t("Already paid") : t("Already completed")}
        </label>
        <details className="rules disclosure">
          <summary>
            <span>
              <Bell size={18} />
              {t("Reminders")}
            </span>
            <span className="muted">
              {value.status !== "open"
                ? t("Paused")
                : value.rules.length === 0
                  ? t("None")
                  : value.rules.length}
            </span>
          </summary>
          <div className="section-heading">
            <button
              type="button"
              className="text-button"
              onClick={() => field("rules", defaults(value.kind))}
            >
              {t("Reset defaults")}
            </button>
          </div>
          {value.status !== "open" && (
            <p className="muted">
              {t("Reminders are paused while this item is finished.")}
            </p>
          )}
          {value.rules.map((r, i) => (
            <div className="rule-row" key={i}>
              <select
                aria-label={t("Reminder {number} mode", { number: i + 1 })}
                value={r.mode}
                onChange={(e) =>
                  rule(i, { mode: e.target.value as Rule["mode"] })
                }
              >
                <option value="before">{t("Minutes before")}</option>
                <option value="day">{t("Days from due date")}</option>
              </select>
              <input
                aria-label={t("Reminder {number} offset", { number: i + 1 })}
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
                  aria-label={t("Reminder {number} time", { number: i + 1 })}
                  required
                  value={r.at}
                  onChange={(e) => rule(i, { at: e.target.value })}
                />
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={t("Remove reminder {number}", { number: i + 1 })}
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
            {t(
              "Days: -1 = before, 0 = due date, +1 = after. Past times are skipped.",
            )}
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
            <Plus size={15} />
            {t("Add reminder")}
          </button>
        </details>
        {!!value.duplicates.length && (
          <label className="checkbox-label notice">
            <input
              required
              type="checkbox"
              checked={duplicateAccepted}
              onChange={(e) => setDuplicateAccepted(e.target.checked)}
            />
            {t("I reviewed the duplicate warning and want to save this bill.")}
          </label>
        )}
        {!!notes.length && (
          <details className="disclosure extraction-notes">
            <summary>{t("Extraction details")}</summary>
            {notes.map((note) => (
              <p className="muted" key={note}>
                {messageText(note)}
              </p>
            ))}
          </details>
        )}
        {error && (
          <p className="error" role="alert">
            {messageText(error)}
          </p>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy
              ? t("Saving…")
              : itemId
                ? t("Save changes")
                : t("Confirm & save")}
            <Check size={17} />
          </button>
        </div>
      </form>
    </dialog>
  );
}
