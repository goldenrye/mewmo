import { messageText, t } from "./i18n";
import { useState } from "react";
import {
  biometricNeedsRenewal,
  clearBiometrics,
  enableBiometrics,
} from "./biometrics";
import { useBiometricStatus } from "./useBiometricStatus";

export function BiometricSettings() {
  const {
    supported,
    status,
    checking,
    error: statusError,
    refresh,
  } = useBiometricStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  if (!supported) return null;
  const needsRenewal = biometricNeedsRenewal(status);
  async function toggle(disable: boolean) {
    if (!status || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (disable) await clearBiometrics();
      else await enableBiometrics();
      const next = await refresh();
      if (!next) return;
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
        {t("{method} sign-in", { method: t(status?.label || "Face ID") })}
        {status && <> · {status.enabled ? t("On") : t("Off")}</>}
        {needsRenewal && <> · {t("Renewal needed")}</>}
      </summary>
      <p className="muted small">
        {t(
          "Unlock your saved session on this iPhone. Your password is still needed after 7 days or if you sign out.",
        )}
      </p>
      {checking && (
        <p role="status" className="muted small">
          {t("Checking biometric status...")}
        </p>
      )}
      {statusError && (
        <p role="alert" className="error">
          {t(statusError)}
        </p>
      )}
      {(statusError || needsRenewal) && (
        <button
          className="text-button"
          disabled={busy || checking}
          onClick={() => void refresh()}
        >
          {t("Retry status check")}
        </button>
      )}
      {needsRenewal && (
        <p className="muted small">
          {t(
            "{method} is still enabled, but its saved sign-in needs renewal.",
            { method: t(status!.label) },
          )}
        </p>
      )}
      {status && !status.available && (
        <p className="muted small">
          {t("Set up or allow {method} in iPhone Settings to use it.", {
            method: t(status.label),
          })}
        </p>
      )}
      {status && (
        <button
          className="secondary"
          disabled={
            busy ||
            checking ||
            (!status.available && (!status.enabled || needsRenewal))
          }
          onClick={() => void toggle(status.enabled && !needsRenewal)}
        >
          {busy
            ? t("Please wait...")
            : t(
                needsRenewal
                  ? "Renew {method} sign-in"
                  : status.enabled
                    ? "Disable {method}"
                    : "Enable {method}",
                {
                  method: t(status.label),
                },
              )}
        </button>
      )}
      {needsRenewal && (
        <button
          className="text-button"
          disabled={busy || checking}
          onClick={() => void toggle(true)}
        >
          {t("Disable {method}", { method: t(status!.label) })}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {messageText(error)}
        </p>
      )}
      {message && <p role="status">{messageText(message)}</p>}
    </details>
  );
}
