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
              "Biometric settings are unavailable. Reopen the app to try again.",
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
        {error}
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
          ? `${next.label} is ready for your next app launch.`
          : `${next.label} sign-in is off.`,
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
        {status.label} sign-in · {status.enabled ? "On" : "Off"}
      </summary>
      <p className="muted small">
        Unlock your saved session on this iPhone. Your password is still needed
        after 7 days or if you sign out.
      </p>
      {!status.available && (
        <p className="muted small">
          Set up or allow {status.label} in iPhone Settings to use it.
        </p>
      )}
      <button
        className="secondary"
        disabled={busy || (!status.available && !status.enabled)}
        onClick={() => void toggle()}
      >
        {busy
          ? "Please wait..."
          : `${status.enabled ? "Disable" : "Enable"} ${status.label}`}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
