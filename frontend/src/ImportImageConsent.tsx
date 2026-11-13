import { t } from "./i18n";
import { ChevronDown } from "lucide-react";
import type { ModelSettings } from "./types";

export function ImportImageConsent({
  settings,
  checked,
  disabled,
  onChange,
  kind = "reminder",
}: {
  settings: ModelSettings | null;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  kind?: "reminder" | "note";
}) {
  const canShare =
    settings?.available && settings.enabled && settings.allow_images;
  return (
    <details
      className={`import-options ${canShare && checked ? "images-enabled" : ""}`}
    >
      <summary>
        <span>{t("PDF or image")}</span>
        <span className="import-options-label">
          {t(canShare && checked ? "AI images on" : "Import options")}
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      </summary>
      <div className="import-options-body">
        <p>{t("Review before saving. Originals are discarded.")}</p>
        <p>{t("Up to 12 MB, 5 PDF pages, or 25 MP per image.")}</p>
        {settings?.enabled && (
          <p>
            {t(
              kind === "note"
                ? "AI suggests a title from extracted text. Image sharing is optional."
                : "AI-first capture. Local parsing takes over if your models are unavailable.",
            )}
          </p>
        )}
        {canShare && (
          <>
            <p>
              {t(
                "AI already reads extracted text. This also shares the images.",
              )}
            </p>
            <label className="ai-toggle">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                aria-label={t(
                  (settings.models?.length ?? 1) > 1
                    ? "Send document images to my configured AI models for this import"
                    : "Send document images to my AI provider for this import",
                )}
                onChange={(event) => onChange(event.target.checked)}
              />
              <span>{t("Share images with AI")}</span>
            </label>
            {(settings.models?.length ?? 0) > 1 && (
              <p className="image-model-chain">
                {t("Tried in order: {models}", {
                  models: settings
                    .models!.map(
                      (model) => `${model.provider} / ${model.model}`,
                    )
                    .join(" → "),
                })}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
