import { useEffect, useRef, useState } from "react";
import { Bell, Check, X } from "lucide-react";
import { api } from "./api";
import { messageText, t } from "./i18n";
import type { Note, NoteDraft } from "./types";

export function NoteEditor({
  initial,
  onClose,
  onSaved,
  onDeleted,
  onReminder,
}: {
  initial: Pick<Note, "title" | "body"> & Partial<Note> & Partial<NoteDraft>;
  onClose: () => void;
  onSaved: (note: Note) => void;
  onDeleted: () => void;
  onReminder: (note: Note) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(!initial.id);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !title.trim() || !body.trim()) return;
    setBusy(true);
    setError("");
    try {
      const note = await api<Note>(
        initial.id ? `/notes/${initial.id}` : "/notes",
        {
          method: initial.id ? "PUT" : "POST",
          body: JSON.stringify({
            confirmed: true,
            title,
            body,
            ...(initial.id ? { version: initial.version } : {}),
          }),
        },
      );
      onSaved(note);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/notes/${initial.id}?version=${initial.version}`, {
        method: "DELETE",
      });
      onDeleted();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="editor-dialog note-dialog"
      aria-label={t("Note")}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <form onSubmit={save}>
        <div className="dialog-heading">
          <h2>
            {t(editing ? (initial.id ? "Edit note" : "Review note") : "Note")}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Close note")}
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {!initial.id && (
          <p className="muted">{t("Nothing is saved until you confirm.")}</p>
        )}
        {!initial.id && initial.source === "file" && (
          <section className="note-import-details">
            <p className="muted small">
              {t(
                initial.interpretation === "ai"
                  ? "AI-assisted import"
                  : "Local import",
              )}
            </p>
            {initial.warnings
              ?.filter(
                (warning) =>
                  warning.startsWith("This note exceeds") ||
                  warning.startsWith("Possible duplicate:") ||
                  warning.startsWith("AI assistance was unavailable") ||
                  warning.startsWith("Image analysis was unavailable"),
              )
              .map((warning) => (
                <p className="notice" role="status" key={warning}>
                  {messageText(warning)}
                </p>
              ))}
            <details className="disclosure">
              <summary>{t("Extraction details")}</summary>
              {initial.warnings?.map((warning) => (
                <p className="muted small" key={warning}>
                  {messageText(warning)}
                </p>
              ))}
            </details>
          </section>
        )}
        {editing ? (
          <>
            <label>
              {t("Title")}
              <input
                autoFocus
                required
                maxLength={180}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              {t("Note text")}
              <textarea
                required
                rows={8}
                maxLength={10000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                disabled={busy}
              />
            </label>
            <p className="muted small">
              {t("No date, time, or notifications. Just a note.")}
            </p>
            <div className="dialog-footer">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={onClose}
              >
                {t("Cancel")}
              </button>
              <button
                className="primary"
                disabled={busy || !title.trim() || !body.trim()}
              >
                {t(
                  busy
                    ? "Saving…"
                    : initial.id
                      ? "Save changes"
                      : "Confirm & save",
                )}
                <Check size={17} />
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="note-title">{initial.title}</h3>
            <p className="note-body">{initial.body}</p>
            <div className="note-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                {t("Edit note")}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => onReminder(initial as Note)}
              >
                <Bell size={18} />
                {t("Add reminder")}
              </button>
            </div>
            <p className="muted small">
              {t("Adding a reminder keeps this note unchanged.")}
            </p>
            <div className="delete-section">
              {deleting ? (
                <>
                  <p>
                    {t(
                      "Delete this note? Reminders created from it will stay.",
                    )}
                  </p>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    {t("Yes, delete note")}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => setDeleting(false)}
                  >
                    {t("Keep note")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="text-button danger"
                  onClick={() => setDeleting(true)}
                >
                  {t("Delete note")}
                </button>
              )}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {messageText(error)}
          </p>
        )}
      </form>
    </dialog>
  );
}
