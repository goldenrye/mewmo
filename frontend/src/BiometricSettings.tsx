import { messageText, t } from "./i18n";
import { useEffect, useState } from "react";
import {
  biometricStatus,
  clearBiometrics,
  enableBiometrics,
  supportsBiometrics,
  type BiometricStatus,
} from "./biometrics";

export function BiometricSettings() {
  const [status, setStatus] = useState<BiometricStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    if (supportsBiometrics()) {
      void biometricStatus()
        .then((value) => {
          if (live) setStatus(value);
        })
        .catch(() => {
          if (live)
            setError(
              t(
                "Biometric settings are unavailable. Reopen the app to try again.",
              ),
            );
        });
    }
    return () => {
      live = false;
    };
  }, []);
  if (!supportsBiometrics()) return null;
  if (!status)
    return error ? (
      <p className="error" role="alert">
        {messageText(error)}
      </p>
    ) : null;
  async function toggle() {
    if (!status || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (status.enabled) await clearBiometrics();
      else await enableBiometrics();
      const next = await biometricStatus();
      setStatus(next);
      setMessage(
        next.enabled
          ? t("{method} is ready for your next app launch.", {
              method: t(next.label),
            })
          : t("{method} sign-in is off.", { method: t(next.label) }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="disclosure">
      <summary>
        {t("{method} sign-in", { method: t(status.label) })} ·{" "}
        {status.enabled ? t("On") : t("Off")}
      </summary>
      <p className="muted small">
        {t(
          "Unlock your saved session on this iPhone. Your password is still needed after 7 days or if you sign out.",
        )}
      </p>
      {!status.available && (
        <p className="muted small">
          {t("Set up or allow {method} in iPhone Settings to use it.", {
            method: t(status.label),
          })}
        </p>
      )}
      <button
        className="secondary"
        disabled={busy || (!status.available && !status.enabled)}
        onClick={() => void toggle()}
      >
        {busy
          ? t("Please wait...")
          : t(status.enabled ? "Disable {method}" : "Enable {method}", {
              method: t(status.label),
            })}
      </button>
      {error && (
        <p className="error" role="alert">
          {messageText(error)}
        </p>
      )}
      {message && <p role="status">{messageText(message)}</p>}
    </details>
  );
}
