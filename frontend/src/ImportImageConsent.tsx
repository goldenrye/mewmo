import { t } from "./i18n";
import type { ModelSettings } from "./types";

export function ImportImageConsent({
  settings,
  checked,
  disabled,
  onChange,
}: {
  settings: ModelSettings | null;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  if (!settings?.available || !settings.enabled || !settings.allow_images)
    return null;
  return (
    <label className="ai-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {t(
          (settings.models?.length ?? 1) > 1
            ? "Send document images to my configured AI models for this import"
            : "Send document images to my AI provider for this import",
        )}
        <small className="image-model-chain">
          {t("AI already reads extracted text. This also shares the images.")}
        </small>
        {(settings.models?.length ?? 0) > 1 && (
          <small className="image-model-chain">
            {t("Tried in order: {models}", {
              models: settings
                .models!.map((model) => `${model.provider} / ${model.model}`)
                .join(" → "),
            })}
          </small>
        )}
      </span>
    </label>
  );
}
