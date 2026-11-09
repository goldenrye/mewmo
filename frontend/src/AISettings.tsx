import { useEffect, useState } from "react";
import { api } from "./api";
import { messageText, t } from "./i18n";
import {
  blankModel,
  ModelFields,
  storedModels,
  type ModelDraft,
} from "./ModelFields";
import "./model-settings.css";
import type { ModelSettings } from "./types";

export function AISettings({
  onChange,
}: {
  onChange: (value: ModelSettings) => void;
}) {
  const [saved, setSaved] = useState<ModelSettings | null>(null);
  const [entries, setEntries] = useState<ModelDraft[]>(() => [blankModel()]);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [images, setImages] = useState(false);
  const [noteSearch, setNoteSearch] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);

  function apply(value: ModelSettings) {
    setSaved(value);
    const models = storedModels(value);
    setEntries(
      models.length
        ? models.map((model) => ({
            ...model,
            localId: model.id,
            apiKey: "",
          }))
        : [blankModel()],
    );
    setTested({});
    setEnabled(value.enabled);
    setImages(value.allow_images);
    setNoteSearch(value.allow_note_search ?? !value.has_key);
    setDirty(false);
  }
  useEffect(() => {
    let live = true;
    setError("");
    void api<ModelSettings>("/model-settings")
      .then((value) => {
        if (live) apply(value);
      })
      .catch((reason) => {
        if (live) setError(reason.message);
      });
    return () => {
      live = false;
    };
  }, [reload]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !saved?.available) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await api<ModelSettings>("/model-settings/models", {
        method: "PUT",
        body: JSON.stringify({
          models: entries.map((entry) => ({
            id: entry.id,
            provider: entry.provider,
            model: entry.model.trim(),
            api_key: entry.apiKey || null,
          })),
          revision: saved.revision ?? 0,
          enabled,
          allow_images: images,
          allow_note_search: noteSearch,
        }),
      });
      apply(value);
      onChange(value);
      setMessage("AI settings saved.");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setEntries((current) =>
        current.map((entry) => ({ ...entry, apiKey: "" })),
      );
      setBusy(false);
    }
  }
  async function test(id: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(
        `/model-settings/test${id === "primary" ? "" : `?model_id=${encodeURIComponent(id)}`}`,
        { method: "POST" },
      );
      setTested((current) => ({ ...current, [id]: "Connection successful." }));
    } catch (reason) {
      setTested((current) => ({ ...current, [id]: (reason as Error).message }));
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`/model-settings?revision=${saved?.revision ?? 0}`, {
        method: "DELETE",
      });
      const value: ModelSettings = {
        available: saved?.available ?? false,
        provider: "openai",
        model: "",
        has_key: false,
        enabled: false,
        allow_images: false,
        allow_note_search: true,
        models: [],
        revision: 0,
      };
      apply(value);
      onChange(value);
      setRemove(false);
      setMessage("Model removed. Local parsing is still available.");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changed() {
    setDirty(true);
    setMessage("");
    setTested({});
    setRemove(false);
  }
  function move(index: number, delta: number) {
    setEntries((current) => {
      const next = [...current];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
    changed();
  }
  return (
    <section className="settings-card account-card ai-settings">
      <h2>{t("AI assistance")}</h2>
      <p className="muted">
        {t("Use your own model for reminders and note search.")}
      </p>
      {saved && (
        <p>
          {t(saved.enabled ? "AI assistance is on." : "Local parsing only.")}
        </p>
      )}
      {saved && !saved.available && (
        <p className="muted">
          {t(
            "AI settings are unavailable. Ask the server administrator to configure encryption.",
          )}
        </p>
      )}
      <details className="disclosure">
        <summary>{t("Configure model")}</summary>
        {!saved && !error && <p role="status">{t("Loading...")}</p>}
        {!saved && error && (
          <button className="secondary" onClick={() => setReload(reload + 1)}>
            {t("Retry")}
          </button>
        )}
        {saved && (
          <form onSubmit={save} onChange={changed}>
            <fieldset disabled={busy}>
              <p className="muted">
                {t(
                  "The first model is the default. If it fails, Mewmo tries the next, then falls back to local parsing. Up to 5 models.",
                )}
              </p>
              {entries.map((entry, index) => (
                <section
                  className="model-entry"
                  key={entry.localId}
                  aria-label={t("Model {number}", { number: index + 1 })}
                >
                  <div className="model-heading">
                    <h3>
                      {t("Model {number}", { number: index + 1 })}{" "}
                      <span className="muted small">
                        {t(index === 0 ? "Default" : "Fallback")}
                      </span>
                    </h3>
                    <div className="model-order">
                      <button
                        type="button"
                        className="secondary"
                        aria-label={t("Move model {number} up", {
                          number: index + 1,
                        })}
                        disabled={index === 0 || !saved.available}
                        onClick={() => move(index, -1)}
                      >
                        {t("Move up")}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        aria-label={t("Move model {number} down", {
                          number: index + 1,
                        })}
                        disabled={
                          index === entries.length - 1 || !saved.available
                        }
                        onClick={() => move(index, 1)}
                      >
                        {t("Move down")}
                      </button>
                    </div>
                  </div>
                  <ModelFields
                    entry={entry}
                    saved={storedModels(saved).find(
                      (model) => model.id === entry.id,
                    )}
                    available={saved.available}
                    onChange={(value) => {
                      setEntries((current) =>
                        current.map((item) =>
                          item.localId === entry.localId
                            ? { ...item, ...value }
                            : item,
                        ),
                      );
                      if (value.provider) {
                        setEnabled(false);
                        setImages(false);
                      }
                    }}
                  />
                  <div className="ai-actions">
                    <button
                      className="secondary"
                      type="button"
                      disabled={!saved.available || dirty || !entry.id}
                      onClick={() => void test(entry.id!)}
                    >
                      {t("Test saved model")}
                    </button>
                    {entries.length > 1 && (
                      <button
                        type="button"
                        className="text-button danger"
                        disabled={!saved.available}
                        aria-label={t("Remove model {number}", {
                          number: index + 1,
                        })}
                        onClick={() => {
                          setEntries((current) =>
                            current.filter(
                              (item) => item.localId !== entry.localId,
                            ),
                          );
                          changed();
                        }}
                      >
                        {t("Remove from list")}
                      </button>
                    )}
                  </div>
                  {entry.id && tested[entry.id] && (
                    <p className="small">{messageText(tested[entry.id])}</p>
                  )}
                </section>
              ))}
              <button
                type="button"
                className="secondary"
                disabled={!saved.available || entries.length >= 5}
                onClick={() => {
                  setEntries((current) => [...current, blankModel()]);
                  changed();
                }}
              >
                {t("Add model")}
              </button>
              <p className="muted">
                {t(
                  "Your key is encrypted on the Mewmo server and never shown again. Provider usage is billed to you.",
                )}
              </p>
              <label className="ai-toggle">
                <input
                  type="checkbox"
                  disabled={!saved.available}
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                <span>{t("Enable AI assistance")}</span>
              </label>
              <p className="muted">
                {t(
                  "When enabled, input may be sent to each configured provider in order until one succeeds. Recognizable account numbers are redacted, but other personal information may remain. Each attempt may incur charges.",
                )}
              </p>
              <p className="muted">
                {t(
                  "Notes are saved without AI rewriting. Optional AI note search sends only your search phrase, never your saved notes.",
                )}
              </p>
              <label className="ai-toggle">
                <input
                  type="checkbox"
                  disabled={!saved.available || !enabled}
                  checked={noteSearch}
                  onChange={(event) => setNoteSearch(event.target.checked)}
                />
                <span>{t("Use AI for note search")}</span>
              </label>
              <p className="muted">
                {t(
                  "Automatically interpret searches using the ordered models. Only your search phrase is sent, never saved notes. If all models fail, search uses local matching.",
                )}
              </p>
              {saved.has_key && !saved.allow_note_search && (
                <p className="muted">
                  {t(
                    "Note search stays local until you enable this setting and save.",
                  )}
                </p>
              )}
              <label className="ai-toggle">
                <input
                  type="checkbox"
                  disabled={!saved.available}
                  checked={images}
                  onChange={(event) => setImages(event.target.checked)}
                />
                <span>{t("Allow optional image analysis")}</span>
              </label>
              <p className="muted">
                {t(
                  "Images can include full account details. You must also opt in for each import. Provider retention policies apply; Mewmo discards its copy.",
                )}
              </p>
              <div className="ai-actions">
                <button className="primary" disabled={busy || !saved.available}>
                  {t("Save AI settings")}
                </button>
              </div>
              {dirty && (
                <p className="muted">{t("Save changes before testing.")}</p>
              )}
            </fieldset>
          </form>
        )}
        {saved?.has_key && (
          <div className="ai-actions">
            {!remove ? (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setRemove(true)}
              >
                {t(
                  (saved.models?.length ?? 1) > 1
                    ? "Remove all models"
                    : "Remove model",
                )}
              </button>
            ) : (
              <>
                <p>
                  {t(
                    (saved.models?.length ?? 1) > 1
                      ? "Remove all models and their saved API keys?"
                      : "Remove this model and its saved API key?",
                  )}
                </p>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  {t("Confirm removal")}
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setRemove(false)}
                >
                  {t("Cancel")}
                </button>
              </>
            )}
          </div>
        )}
      </details>
      {busy && <p role="status">{t("Please wait...")}</p>}
      {message && <p role="status">{messageText(message)}</p>}
      {error && (
        <p role="alert" className="error">
          {messageText(error)}
          {saved && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setReload((value) => value + 1)}
            >
              {t("Reload saved settings")}
            </button>
          )}
        </p>
      )}
    </section>
  );
}
