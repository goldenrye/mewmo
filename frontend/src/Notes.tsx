import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  NotebookPen,
  Search,
} from "lucide-react";
import { api } from "./api";
import { messageText, t } from "./i18n";
import { NoteEditor } from "./NoteEditor";
import { VoiceInput } from "./VoiceInput";
import type { Note, NoteResults } from "./types";
import "./notes.css";

export function Notes({
  aiEnabled,
  blocked,
  onReminder,
}: {
  aiEnabled: boolean;
  blocked: boolean;
  onReminder: (note: Note) => void;
}) {
  const [mode, setMode] = useState<"write" | "find">("write");
  const [noteText, setNoteText] = useState("");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const [result, setResult] = useState<NoteResults | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<
    (Pick<Note, "title" | "body"> & Partial<Note>) | null
  >(null);
  const [useAI, setUseAI] = useState(false);
  const [activeAI, setActiveAI] = useState(false);
  const request = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const text = mode === "write" ? noteText : query;
  const setText = mode === "write" ? setNoteText : setQuery;

  async function load(search: string | null, nextOffset = 0, withAI = false) {
    const id = ++request.current;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const found =
        search === null
          ? await api<NoteResults>(`/notes?offset=${nextOffset}`)
          : await api<NoteResults>("/notes/search", {
              method: "POST",
              body: JSON.stringify({
                query: search,
                offset: nextOffset,
                use_ai: withAI,
              }),
            });
      if (id !== request.current) return;
      setResult(found);
      setOffset(nextOffset);
      setActiveQuery(search);
      setActiveAI(withAI);
    } catch (reason) {
      if (id === request.current) setError((reason as Error).message);
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  async function openNote(noteId: string) {
    if (busy || voiceBusy || blocked) return;
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const fresh = await api<Note>(`/notes/${noteId}`);
      if (id === request.current) setEditor(fresh);
    } catch (reason) {
      if (id === request.current) setError((reason as Error).message);
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load(null);
    return () => {
      request.current++;
    };
  }, []);
  useEffect(() => {
    if (!aiEnabled) setUseAI(false);
  }, [aiEnabled]);
  useEffect(() => {
    if (voiceBusy && input.current)
      input.current.scrollTop = input.current.scrollHeight;
  }, [text, voiceBusy]);

  function submit() {
    if (!text.trim() || voiceBusy || busy || blocked) return;
    if (text.length > (mode === "write" ? 10000 : 500)) {
      setError(
        t(
          mode === "write"
            ? "Keep notes under 10,000 characters."
            : "Keep searches under 500 characters.",
        ),
      );
      return;
    }
    setError("");
    setMessage("");
    if (mode === "find") void load(query.trim(), 0, useAI && aiEnabled);
    else
      setEditor({
        title: noteText.trim().split(/\n/)[0].slice(0, 80),
        body: noteText.trim(),
      });
  }
  return (
    <div className="notes-workspace">
      <section className="capture-card">
        <div className="tabs note-modes" aria-label={t("Note action")}>
          <button
            className={mode === "write" ? "active" : ""}
            aria-pressed={mode === "write"}
            onClick={() => {
              setMode("write");
              setError("");
            }}
            disabled={busy || blocked}
          >
            {t("Write a note")}
          </button>
          <button
            className={mode === "find" ? "active" : ""}
            aria-pressed={mode === "find"}
            onClick={() => {
              setMode("find");
              setError("");
            }}
            disabled={busy || blocked}
          >
            {t("Find notes")}
          </button>
        </div>
        <p className="muted small">
          {t(
            mode === "write"
              ? "No date, time, or notifications. Just a note."
              : 'Ask for a topic, like "the notes about the floor".',
          )}
        </p>
        <div className="capture-input">
          <textarea
            ref={input}
            rows={3}
            maxLength={mode === "write" ? 10000 : 500}
            aria-label={t(mode === "write" ? "Note text" : "Search notes")}
            value={text}
            readOnly={voiceBusy || busy}
            onChange={(event) => setText(event.target.value)}
            placeholder={t(
              mode === "write"
                ? "e.g. Living room floor: 5 m by 4 m."
                : "e.g. the notes about the floor",
            )}
            onKeyDown={(event) => {
              if (
                mode === "find" &&
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button
            className="parse-button"
            aria-label={t(mode === "write" ? "Preview note" : "Search notes")}
            disabled={!text.trim() || voiceBusy || busy || blocked}
            onClick={submit}
          >
            {busy ? (
              <span className="spinner" />
            ) : mode === "find" ? (
              <Search size={21} />
            ) : (
              <ArrowRight size={21} />
            )}
          </button>
        </div>
        <VoiceInput
          key={mode}
          disabled={busy || !!editor || blocked}
          aiEnabled={false}
          triggerLabel={
            mode === "write" ? "Add a note by audio" : "Find notes by audio"
          }
          unavailableLabel="Speech recognition is unavailable here. Use keyboard dictation or type your text."
          onBusy={setVoiceBusy}
          onText={setText}
          onReset={() => {
            setText("");
            setError("");
            setMessage("");
            input.current?.blur();
            input.current
              ?.closest(".capture-card")
              ?.scrollIntoView({ block: "start" });
          }}
        />
        {mode === "find" && aiEnabled && (
          <label className="ai-toggle note-ai">
            <input
              type="checkbox"
              checked={useAI}
              disabled={voiceBusy || busy}
              onChange={(event) => setUseAI(event.target.checked)}
            />
            <span>
              {t("Use AI to understand this search")}
              <small>
                {t(
                  "Only your search phrase is sent to your provider, not saved notes.",
                )}
              </small>
            </span>
          </label>
        )}
      </section>
      {error && (
        <div role="alert" className="error">
          {messageText(error)}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void load(null)}
          >
            {t("Retry")}
          </button>
        </div>
      )}
      {message && <p role="status">{t(message)}</p>}
      <section className="list-panel" aria-label={t("Your notes")}>
        <div className="section-heading">
          <h2>
            {t(activeQuery === null ? "Your notes" : "Matching notes")}
            {result && <span className="count">{result.total}</span>}
          </h2>
          {activeQuery !== null && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void load(null)}
            >
              {t("Show all notes")}
            </button>
          )}
        </div>
        {busy && <p role="status">{t("Loading...")}</p>}
        {result?.warning && (
          <p role="status" className="notice">
            {messageText(result.warning)}
          </p>
        )}
        {result?.mode === "ai" && (
          <p className="muted small">
            {t("AI-assisted search. Results are your saved notes.")}
          </p>
        )}
        {result?.items.map((note) => (
          <button
            className="note-card"
            key={note.id}
            onClick={() => void openNote(note.id)}
            disabled={busy || voiceBusy || blocked}
          >
            <NotebookPen size={22} aria-hidden="true" />
            <span>
              <strong>{note.title}</strong>
              <span className="note-excerpt">{note.body}</span>
            </span>
          </button>
        ))}
        {result && !result.items.length && (
          <div className="empty-state">
            <NotebookPen size={30} />
            <h3>
              {t(activeQuery === null ? "No notes yet" : "No matching notes")}
            </h3>
            <p>
              {t(
                activeQuery === null
                  ? "Keep details here. Find them later by typing or speaking."
                  : "Try another topic or show all notes.",
              )}
            </p>
          </div>
        )}
        {result && result.total > 50 && (
          <div className="note-pagination">
            <button
              className="secondary"
              aria-label={t("Previous notes")}
              disabled={busy || offset === 0}
              onClick={() =>
                void load(activeQuery, offset - 50, activeAI && aiEnabled)
              }
            >
              <ChevronLeft size={20} />
            </button>
            <span>
              {t("{start}-{end} of {total}", {
                start: offset + 1,
                end: offset + result.items.length,
                total: result.total,
              })}
            </span>
            <button
              className="secondary"
              aria-label={t("Next notes")}
              disabled={busy || offset + 50 >= result.total}
              onClick={() =>
                void load(activeQuery, offset + 50, activeAI && aiEnabled)
              }
            >
              <ChevronRight size={20} />
            </button>
          </div>
        )}
      </section>
      {editor && (
        <NoteEditor
          key={editor.id || "new"}
          initial={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setNoteText("");
            setMessage("Note saved.");
            void load(activeQuery, 0, activeAI && aiEnabled);
          }}
          onDeleted={() => {
            setEditor(null);
            setMessage("Note deleted.");
            void load(activeQuery, 0, activeAI && aiEnabled);
          }}
          onReminder={(note) => {
            setEditor(null);
            onReminder(note);
          }}
        />
      )}
    </div>
  );
}
