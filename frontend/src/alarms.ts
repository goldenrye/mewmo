import { Capacitor, registerPlugin } from "@capacitor/core";
import { getLocale } from "./i18n";
import type { Item } from "./types";

export type AlarmSnapshot = {
  available: boolean;
  authorization: "unavailable" | "notDetermined" | "denied" | "authorized";
  enabled: boolean;
  states: Record<string, string>;
  error?: string;
};
type AlarmItem = { id: string; active: boolean; title: string; fireAt: number };
interface AlarmBridge {
  bind(options: { owner: string | null }): Promise<AlarmSnapshot>;
  authorize(options: { owner: string }): Promise<AlarmSnapshot>;
  disable(options: { owner: string }): Promise<AlarmSnapshot>;
  sync(options: {
    owner: string;
    items: AlarmItem[];
    complete: boolean;
    force: boolean;
    language: string;
  }): Promise<AlarmSnapshot>;
}
const bridge = registerPlugin<AlarmBridge>("MewmoUrgentAlarms");
const unavailable: AlarmSnapshot = {
  available: false,
  authorization: "unavailable",
  enabled: false,
  states: {},
};
let snapshot = unavailable;
let owner: string | null = null;
let boundOwner: string | null | undefined;
let epoch = 0;
let revision = 0;
let tail: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const failure =
  "Could not update iPhone alarms. Existing alarms may still ring.";

export const alarmSnapshot = () => snapshot;
export const alarmRevision = () => revision;
export const alarmEpoch = () => epoch;
export function subscribeAlarms(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(value: AlarmSnapshot) {
  snapshot = value;
  listeners.forEach((listener) => listener());
}
function supported() {
  return (
    Capacitor.getPlatform() === "ios" &&
    Capacitor.isPluginAvailable("MewmoUrgentAlarms")
  );
}
async function ensureBound(target: string) {
  if (boundOwner !== target) {
    await bridge.bind({ owner: target });
    boundOwner = target;
  }
}
function queue(work: () => Promise<AlarmSnapshot>, version = epoch) {
  const task = tail
    .catch(() => {})
    .then(async () => {
      if (version !== epoch)
        throw new Error("Account changed. Request discarded.");
      try {
        const result = await work();
        if (version !== epoch)
          throw new Error("Account changed. Request discarded.");
        publish(result);
        return result;
      } catch (error) {
        if (version === epoch)
          publish({ ...snapshot, states: {}, error: failure });
        throw error;
      }
    });
  tail = task.catch(() => {});
  return task;
}

export function bindAlarmAccount(userId: string | null, server = "") {
  owner = userId ? `${server}#${userId}` : null;
  boundOwner = undefined;
  epoch++;
  revision++;
  publish(unavailable);
  if (!supported()) return Promise.resolve(unavailable);
  const target = owner;
  return queue(async () => {
    const result = await bridge.bind({ owner: target });
    boundOwner = target;
    return result;
  });
}

export async function authorizeAlarms() {
  const target = owner;
  if (!target || !supported()) return unavailable;
  const result = await queue(async () => {
    await ensureBound(target);
    return bridge.authorize({ owner: target });
  });
  if (result.available && result.authorization !== "authorized") {
    throw new Error(
      "Allow alarms in iPhone Settings, or turn off Urgent alarm.",
    );
  }
  return result;
}

export function disableAlarms() {
  const target = owner;
  if (!target || !supported()) return Promise.resolve(unavailable);
  revision++;
  return queue(async () => {
    await ensureBound(target);
    return bridge.disable({ owner: target });
  });
}

export function syncAlarms(
  items: Item[],
  options: {
    complete?: boolean;
    expectedRevision?: number;
    expectedEpoch?: number;
    force?: boolean;
  } = {},
) {
  const target = owner;
  if (options.expectedEpoch !== undefined && options.expectedEpoch !== epoch)
    return Promise.reject(new Error("Account changed. Request discarded."));
  if (!target || !supported()) return Promise.resolve(unavailable);
  if (!options.complete) revision++;
  const expected = options.expectedRevision ?? revision;
  const records = items.map((item) => ({
    id: item.id,
    active: item.urgent === true && item.status === "open",
    title: item.alarm_title || "Mewmo reminder",
    fireAt: new Date(item.due_at).getTime() / 1000,
  }));
  return queue(async () => {
    // A list requested before an edit must not undo the newly scheduled alarm.
    if (options.complete && expected !== revision) return snapshot;
    if (records.some((item) => !Number.isFinite(item.fireAt)))
      throw new Error(failure);
    // Retry failed account cleanup before allowing any new native scheduling.
    await ensureBound(target);
    return bridge.sync({
      owner: target,
      items: records,
      complete: options.complete === true,
      force: options.force === true,
      language: getLocale(),
    });
  });
}

export function alarmMessage(item: Item, state = snapshot): string {
  if (state.error) return state.error;
  if (!item.urgent || item.status !== "open")
    return "No urgent alarm needed for this item.";
  if (!state.available)
    return "Alarm requires the Mewmo iPhone app on iOS 26+. This device uses ordinary notifications only.";
  if (state.authorization !== "authorized")
    return "No alarm scheduled. Allow alarm access on this iPhone.";
  if (!state.enabled)
    return "No alarm scheduled. Enable urgent alarms on this iPhone.";
  const messages: Record<string, string> = {
    scheduled: "Alarm scheduled on this iPhone.",
    alerting: "Alarm is ringing on this iPhone.",
    ended: "Alarm ended or was dismissed. The item is still open.",
    not_scheduled:
      "Alarm was removed on this iPhone. Tap Schedule alarm to restore it.",
    past: "No alarm scheduled: the due time has already passed.",
    limit: "No alarm scheduled: this iPhone has reached its alarm limit.",
    failed:
      "Could not schedule the alarm. Ordinary notifications are unchanged.",
  };
  return (
    messages[state.states[item.id]] ??
    (new Date(item.due_at).getTime() <= Date.now()
      ? messages.past
      : "No alarm scheduled on this iPhone yet.")
  );
}
