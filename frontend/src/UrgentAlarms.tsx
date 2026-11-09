import { useState, useSyncExternalStore } from "react";
import {
  alarmEpoch,
  alarmMessage,
  alarmSnapshot,
  authorizeAlarms,
  disableAlarms,
  subscribeAlarms,
  syncAlarms,
} from "./alarms";
import { messageText, t } from "./i18n";
import type { Item } from "./types";
import { api } from "./api";

export function AlarmCleanupWarning() {
  const state = useSyncExternalStore(subscribeAlarms, alarmSnapshot);
  return state.error ? (
    <p className="notice" role="alert">
      {t(state.error)}
    </p>
  ) : null;
}

export function UrgentAlarmDetails({
  item,
  onUpdated,
}: {
  item: Item;
  onUpdated: (item: Item) => void;
}) {
  const state = useSyncExternalStore(subscribeAlarms, alarmSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function schedule() {
    const epoch = alarmEpoch();
    setBusy(true);
    setError("");
    try {
      await authorizeAlarms();
      const fresh = await api<Item>(`/items/${item.id}`);
      await syncAlarms([fresh], { force: true, expectedEpoch: epoch });
      onUpdated(fresh);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="urgent-alarm disclosure">
      <h3>{t("Urgent alarm")}</h3>
      <p role="status">{t(alarmMessage(item, state))}</p>
      {state.available &&
        item.status === "open" &&
        new Date(item.due_at).getTime() > Date.now() && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void schedule()}
          >
            {t(busy ? "Scheduling alarm..." : "Schedule alarm")}
          </button>
        )}
      <p className="muted small">
        {t(
          "One alarm at the due time. Sounds through Silent mode and Focus; iPhone controls the volume.",
        )}
      </p>
      <p className="muted small">
        {t(
          "Changes made elsewhere apply after this iPhone opens Mewmo and syncs. Until then, an old alarm may still ring.",
        )}
      </p>
      <details>
        <summary>{t("Alarm limitations")}</summary>
        <p className="muted small">
          {t(
            "Stopping an alarm does not complete the reminder. Ordinary push reminders remain separate. Do not rely on this app as your only gas or safety alarm.",
          )}
        </p>
      </details>
      {error && (
        <p className="error" role="alert">
          {messageText(error)}
        </p>
      )}
    </section>
  );
}

export function UrgentAlarmSettings({
  onEnabled,
}: {
  onEnabled: () => Promise<void>;
}) {
  const state = useSyncExternalStore(subscribeAlarms, alarmSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      if (state.enabled) await disableAlarms();
      else {
        await authorizeAlarms();
        await onEnabled();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h2>{t("Urgent alarms")}</h2>
      <p className="muted">
        {t(
          state.available
            ? "Off by default for each reminder. Enable only the alarms you need. Alarm access is separate from push notifications."
            : "Alarm requires the Mewmo iPhone app on iOS 26+. This device uses ordinary notifications only.",
        )}
      </p>
      {state.available && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void toggle()}
        >
          {t(
            busy
              ? "Updating alarms..."
              : state.enabled
                ? "Disable urgent alarms on this iPhone"
                : "Enable urgent alarms on this iPhone",
          )}
        </button>
      )}
      <p className="muted small">
        {t(
          "Web-created urgent reminders are not iPhone alarms until this phone syncs with alarm access enabled.",
        )}
      </p>
      {(error || state.error) && (
        <p className="error" role="alert">
          {messageText(error || state.error!)}
        </p>
      )}
    </section>
  );
}
