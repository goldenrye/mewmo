import { t } from "./i18n";
import type { AIModel, ModelSettings } from "./types";

export type ModelDraft = {
  localId: string;
  id?: string;
  provider: ModelSettings["provider"];
  model: string;
  apiKey: string;
};
export const blankModel = (): ModelDraft => ({
  localId: crypto.randomUUID(),
  provider: "openai",
  model: "",
  apiKey: "",
});
export function storedModels(value: ModelSettings): AIModel[] {
  return (
    value.models ??
    (value.has_key
      ? [
          {
            id: "primary",
            provider: value.provider,
            model: value.model,
            has_key: true,
          },
        ]
      : [])
  );
}
export function ModelFields({
  entry,
  saved,
  available,
  onChange,
}: {
  entry: ModelDraft;
  saved?: AIModel;
  available: boolean;
  onChange: (value: Partial<ModelDraft>) => void;
}) {
  const keepKey = saved?.has_key && saved.provider === entry.provider;
  return (
    <>
      <label>
        {t("Provider")}
        <select
          aria-label={t("Provider")}
          value={entry.provider}
          onChange={(event) =>
            onChange({
              provider: event.target.value as ModelDraft["provider"],
              model: "",
              apiKey: "",
            })
          }
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
          value={entry.model}
          onChange={(event) => onChange({ model: event.target.value })}
        />
      </label>
      <p className="muted">
        {t(
          entry.provider === "doubao"
            ? "Use your Volcengine Ark API key and a Model ID or Endpoint ID (ep-...) from the Beijing region. Image analysis requires a vision-capable model."
            : "Use a model ID supported by your provider. Image analysis requires a vision-capable model.",
        )}
      </p>
      <label>
        {t("API key")}
        <input
          type="password"
          disabled={!available}
          autoComplete="off"
          maxLength={2048}
          required={!keepKey}
          value={entry.apiKey}
          onChange={(event) => onChange({ apiKey: event.target.value })}
          placeholder={keepKey ? t("Saved securely; leave blank to keep") : ""}
        />
      </label>
    </>
  );
}
