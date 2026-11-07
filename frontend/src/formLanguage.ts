import { useEffect } from "react";
import { getLocale, messageText, t } from "./i18n";

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export function useFormLanguage() {
  const locale = getLocale();
  useEffect(() => {
    function clear(field: Field) {
      if (field.dataset.mewmoValidation) {
        field.setCustomValidity("");
        delete field.dataset.mewmoValidation;
      }
    }
    function isField(target: EventTarget | null): target is Field {
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      );
    }
    const reset = (event: Event) => {
      if (isField(event.target)) clear(event.target);
    };
    const invalid = (event: Event) => {
      if (!isField(event.target) || locale !== "zh-CN") return;
      const field = event.target;
      clear(field);
      const validity = field.validity;
      // Do not replace errors owned by other validators.
      if (validity.customError) return;
      let message = t("Please check this value.");
      if (validity.valueMissing) message = t("Field required");
      else if (validity.patternMismatch)
        message = messageText("String should match pattern");
      else if ("minLength" in field && validity.tooShort)
        message = messageText(
          `String should have at least ${field.minLength} characters`,
        );
      else if ("maxLength" in field && validity.tooLong)
        message = messageText(
          `String should have at most ${field.maxLength} characters`,
        );
      else if (field instanceof HTMLInputElement && field.type === "number") {
        if (validity.rangeUnderflow)
          message = messageText(
            `Input should be greater than or equal to ${field.min}`,
          );
        else if (validity.rangeOverflow)
          message = messageText(
            `Input should be less than or equal to ${field.max}`,
          );
      }
      field.setCustomValidity(message);
      field.dataset.mewmoValidation = "true";
    };
    document.addEventListener("invalid", invalid, true);
    document.addEventListener("input", reset, true);
    document.addEventListener("change", reset, true);
    return () => {
      document.removeEventListener("invalid", invalid, true);
      document.removeEventListener("input", reset, true);
      document.removeEventListener("change", reset, true);
      document
        .querySelectorAll<Field>("[data-mewmo-validation]")
        .forEach(clear);
    };
  }, [locale]);
}
