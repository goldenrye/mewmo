import { setLanguage, t, useLanguage, type LanguagePreference } from "./i18n";

export function LanguageSelector() {
  const { preference } = useLanguage();
  return (
    <label className="language-selector">
      <span>{t("Language")}</span>
      <select
        value={preference}
        onChange={(event) =>
          setLanguage(event.target.value as LanguagePreference)
        }
      >
        <option value="system">{t("System default")}</option>
        <option value="en" lang="en">
          English
        </option>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
      </select>
    </label>
  );
}
