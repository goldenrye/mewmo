import { useEffect, useState } from "react";
import { api } from "./api";
import { messageText, t } from "./i18n";
import type { ModelSettings } from "./types";

export function AISettings({
  onChange,
}: {
  onChange: (value: ModelSettings) => void;
}) {
  const [saved, setSaved] = useState<ModelSettings | null>(null);
  const [provider, setProvider] = useState<ModelSettings["provider"]>("openai");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
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
    setProvider(value.provider);
    setModel(value.model);
    setEnabled(value.enabled);
    setImages(value.allow_images);
    setNoteSearch(value.allow_note_search ?? !value.has_key);
    setKey("");
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
      const value = await api<ModelSettings>("/model-settings", {
        method: "PUT",
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: key || null,
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
      setKey("");
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/model-settings/test", { method: "POST" });
      setMessage("Connection successful.");
    } catch (reason) {
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
      await api("/model-settings", { method: "DELETE" });
      const value: ModelSettings = {
        available: saved?.available ?? false,
        provider: "openai",
        model: "",
        has_key: false,
        enabled: false,
        allow_images: false,
        allow_note_search: true,
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
          <form
            onSubmit={save}
            onChange={() => {
              setDirty(true);
              setMessage("");
              setRemove(false);
            }}
          >
            <fieldset disabled={busy}>
              <label>
                {t("Provider")}
                <select
                  aria-label={t("Provider")}
                  value={provider}
                  onChange={(event) => {
                    setProvider(
                      event.target.value as ModelSettings["provider"],
                    );
                    setModel("");
                    setKey("");
                    setEnabled(false);
                    setImages(false);
                  }}
                >
                  <option value="openai">OpenAI (GPT)</option>
                  <option value="anthropic">Claude (Anthropic)</option>
                  <option value="gemini">Gemini (Google)</option>
                  <option value="doubao">{t("Doubao (Volcengine Ark)")}</option>
                </select>
              </label>
              <label>
                {t("Model ID")}
                <input
                  required
                  maxLength={120}
                  pattern="[A-Za-z0-9][A-Za-z0-9._:\-]*"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
              <p className="muted">
                {t(
                  provider === "doubao"
                    ? "Use your Volcengine Ark API key and a Model ID or Endpoint ID (ep-...) from the Beijing region. Image analysis requires a vision-capable model."
                    : "Use a model ID supported by your provider. Image analysis requires a vision-capable model.",
                )}
              </p>
              <label>
                {t("API key")}
                <input
                  type="password"
                  disabled={!saved.available}
                  autoComplete="off"
                  maxLength={2048}
                  required={!saved.has_key || provider !== saved.provider}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={
                    saved.has_key && provider === saved.provider
                      ? t("Saved securely; leave blank to keep")
                      : ""
                  }
                />
              </label>
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
                  "When enabled, new captures send typed input or OCR text to this provider. Recognizable account numbers are redacted, but text may contain other personal information.",
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
                  "Automatically interpret typed and spoken searches using this model. Only your search phrase is sent, never saved notes. Provider charges may apply. If AI is unavailable, search uses local matching.",
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
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || !saved.available || dirty || !saved.has_key}
                  onClick={() => void test()}
                >
                  {t("Test saved model")}
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
                {t("Remove model")}
              </button>
            ) : (
              <>
                <p>{t("Remove this model and its saved API key?")}</p>
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
        </p>
      )}
    </section>
  );
}
