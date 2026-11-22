import { useCallback, useEffect, useRef, useState } from "react";
import {
  biometricStatus,
  supportsBiometrics,
  type BiometricStatus,
} from "./biometrics";

export function useBiometricStatus() {
  const supported = supportsBiometrics();
  const [status, setStatus] = useState<BiometricStatus | null>(null);
  const [checking, setChecking] = useState(supported);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!supported) return null;
    const request = ++generation.current;
    setChecking(true);
    setError("");
    try {
      const value = await biometricStatus();
      if (request !== generation.current) return null;
      setStatus(value);
      return value;
    } catch {
      if (request === generation.current)
        setError(
          "Could not check biometric status. Retry the check or use your password.",
        );
      return null;
    } finally {
      if (request === generation.current) setChecking(false);
    }
  }, [supported]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  return { supported, status, setStatus, checking, error, refresh };
}
