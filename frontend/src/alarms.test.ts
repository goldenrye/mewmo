import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Item } from "./types";

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => "ios"),
  available: vi.fn(() => true),
  bind: vi.fn(),
  authorize: vi.fn(),
  sync: vi.fn(),
  disable: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: mocks.platform,
    isPluginAvailable: mocks.available,
  },
  registerPlugin: () => mocks,
}));
const enabled = {
  available: true,
  authorization: "authorized",
  enabled: true,
  states: {},
};
const unavailable = {
  available: false,
  authorization: "unavailable",
  enabled: false,
  states: {},
};
const item = {
  id: "00000000-0000-4000-8000-000000000002",
  urgent: true,
  status: "open",
  title: "Private bill $120",
  alarm_title: "Turn off gas",
  due_at: "2099-11-09T05:38:00Z",
} as Item;
let alarms: typeof import("./alarms");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.platform.mockReturnValue("ios");
  mocks.available.mockReturnValue(true);
  mocks.bind.mockResolvedValue({ ...enabled, enabled: false });
  mocks.authorize.mockResolvedValue(enabled);
  mocks.sync.mockResolvedValue(enabled);
  mocks.disable.mockResolvedValue({ ...enabled, enabled: false });
  alarms = await import("./alarms");
});
afterEach(() => vi.restoreAllMocks());

it("keeps browsers and old native bundles on ordinary notifications", async () => {
  mocks.platform.mockReturnValue("web");
  await alarms.bindAlarmAccount("alice", "https://mewmo.example/api");
  expect(await alarms.authorizeAlarms()).toEqual(unavailable);
  await alarms.syncAlarms([item]);
  expect(mocks.bind).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(alarms.alarmMessage(item)).toContain("ordinary notifications only");
  mocks.platform.mockReturnValue("ios");
  mocks.available.mockReturnValue(false);
  await alarms.bindAlarmAccount("alice");
  expect(mocks.bind).not.toHaveBeenCalled();
});

it("keeps pre-iOS-26 devices unavailable without reporting a scheduled alarm", async () => {
  mocks.bind.mockResolvedValue(unavailable);
  await alarms.bindAlarmAccount("alice");
  expect(alarms.alarmMessage(item)).toContain("iOS 26+");
});

it("binds an account without asking for permission or scheduling", async () => {
  await alarms.bindAlarmAccount("alice", "https://mewmo.example/api");
  expect(mocks.bind).toHaveBeenCalledWith({
    owner: "https://mewmo.example/api#alice",
  });
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(alarms.alarmMessage(item)).toContain("Enable urgent alarms");
});

it("permission denial is explicit and does not schedule anything", async () => {
  await alarms.bindAlarmAccount("alice");
  mocks.authorize.mockResolvedValue({
    ...enabled,
    enabled: false,
    authorization: "denied",
  });
  await expect(alarms.authorizeAlarms()).rejects.toThrow(
    "Allow alarms in iPhone Settings",
  );
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(alarms.alarmMessage(item)).toContain("No alarm scheduled");
});

it("retries failed account cleanup before the next sync", async () => {
  mocks.bind.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(alarms.bindAlarmAccount("alice")).rejects.toThrow();
  expect(alarms.alarmSnapshot().error).toBeDefined();
  await alarms.syncAlarms([item], { complete: true });
  expect(mocks.bind).toHaveBeenCalledTimes(2);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(alarms.alarmSnapshot().error).toBeUndefined();
});

it("does not schedule or authorize while account cleanup still fails", async () => {
  mocks.bind.mockRejectedValue(new Error("cleanup failed"));
  await expect(alarms.bindAlarmAccount("alice")).rejects.toThrow();
  await expect(alarms.authorizeAlarms()).rejects.toThrow();
  await expect(alarms.syncAlarms([item])).rejects.toThrow();
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(alarms.alarmSnapshot().error).toContain(
    "Existing alarms may still ring",
  );
});

it("sends only the redacted title and absolute due time to native scheduling", async () => {
  await alarms.bindAlarmAccount("alice");
  await alarms.authorizeAlarms();
  await alarms.syncAlarms([item], { force: true });
  expect(mocks.sync).toHaveBeenCalledWith({
    owner: "#alice",
    items: [
      {
        id: item.id,
        active: true,
        title: "Turn off gas",
        fireAt: new Date(item.due_at).getTime() / 1000,
      },
    ],
    complete: false,
    force: true,
    language: expect.any(String),
  });
  expect(JSON.stringify(mocks.sync.mock.calls)).not.toContain("$120");
});

it("does not leak a raw title when talking to an older API", async () => {
  await alarms.bindAlarmAccount("alice");
  await alarms.syncAlarms([{ ...item, alarm_title: undefined }]);
  expect(mocks.sync.mock.calls[0][0].items[0].title).toBe("Mewmo reminder");
});

it("marks ordinary, completed, and disabled urgent items inactive for cancellation", async () => {
  await alarms.bindAlarmAccount("alice");
  for (const value of [
    { ...item, urgent: false },
    { ...item, status: "completed" as const },
    { ...item, status: "paid" as const },
  ]) {
    await alarms.syncAlarms([value]);
    expect(mocks.sync.mock.lastCall?.[0].items[0].active).toBe(false);
  }
});

it("sends an empty complete snapshot to cancel removed items", async () => {
  await alarms.bindAlarmAccount("alice");
  await alarms.syncAlarms([], {
    complete: true,
    expectedRevision: alarms.alarmRevision(),
  });
  expect(mocks.sync).toHaveBeenCalledWith(
    expect.objectContaining({ items: [], complete: true }),
  );
});

it("does not let a stale refresh overwrite a just-saved alarm", async () => {
  await alarms.bindAlarmAccount("alice");
  const revision = alarms.alarmRevision();
  await alarms.syncAlarms([item], { force: true });
  await alarms.syncAlarms([], { complete: true, expectedRevision: revision });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("does not let a pre-disable refresh reenable device alarms", async () => {
  await alarms.bindAlarmAccount("alice");
  const revision = alarms.alarmRevision();
  await alarms.disableAlarms();
  await alarms.syncAlarms([item], {
    complete: true,
    expectedRevision: revision,
  });
  expect(mocks.disable).toHaveBeenCalledWith({ owner: "#alice" });
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("serializes account cleanup after an in-flight permission prompt", async () => {
  await alarms.bindAlarmAccount("alice");
  const epoch = alarms.alarmEpoch();
  let finish!: (result: typeof enabled) => void;
  mocks.authorize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = alarms.authorizeAlarms();
  const rejected = expect(pending).rejects.toThrow("Account changed");
  await vi.waitFor(() => expect(mocks.authorize).toHaveBeenCalled());
  const switched = alarms.bindAlarmAccount("bob");
  await expect(
    alarms.syncAlarms([item], { expectedEpoch: epoch }),
  ).rejects.toThrow("Account changed");
  finish(enabled);
  await rejected;
  await switched;
  expect(mocks.bind.mock.lastCall?.[0]).toEqual({ owner: "#bob" });
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(alarms.alarmSnapshot().error).toBeUndefined();
});

it("discards work queued for a signed-out account", async () => {
  await alarms.bindAlarmAccount("alice");
  const queued = alarms.syncAlarms([item]);
  const rejected = expect(queued).rejects.toThrow("Account changed");
  const cleared = alarms.bindAlarmAccount(null);
  await rejected;
  await cleared;
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.bind.mock.lastCall?.[0]).toEqual({ owner: null });
});

it("suspends expired-session work without resetting native alarms or preferences", async () => {
  await alarms.bindAlarmAccount("alice", "https://mewmo.example/api");
  await alarms.authorizeAlarms();
  const epoch = alarms.alarmEpoch();
  const revision = alarms.alarmRevision();
  mocks.bind.mockClear();
  alarms.suspendAlarmAccount();
  expect(alarms.alarmEpoch()).toBeGreaterThan(epoch);
  expect(alarms.alarmRevision()).toBeGreaterThan(revision);
  expect(alarms.alarmSnapshot()).toEqual(unavailable);
  await alarms.syncAlarms([]);
  await alarms.authorizeAlarms();
  await alarms.disableAlarms();
  expect(mocks.bind).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.disable).not.toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalledTimes(1);
  await expect(
    alarms.syncAlarms([item], { expectedEpoch: epoch }),
  ).rejects.toThrow("Account changed");
});

it("resumes the same native owner after renewal without enabling or clearing alarms", async () => {
  await alarms.bindAlarmAccount("alice", "https://mewmo.example/api");
  const epoch = alarms.alarmEpoch();
  const revision = alarms.alarmRevision();
  alarms.suspendAlarmAccount();
  mocks.bind.mockResolvedValue(enabled);
  await alarms.bindAlarmAccount("alice", "https://mewmo.example/api");
  expect(alarms.alarmSnapshot().enabled).toBe(true);
  await expect(
    alarms.syncAlarms([], { complete: true, expectedEpoch: epoch }),
  ).rejects.toThrow("Account changed");
  await alarms.syncAlarms([], { complete: true, expectedRevision: revision });
  expect(mocks.sync).not.toHaveBeenCalled();
  await alarms.syncAlarms([item], {
    complete: true,
    expectedEpoch: alarms.alarmEpoch(),
  });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(mocks.bind.mock.calls.map(([call]) => call.owner)).toEqual([
    "https://mewmo.example/api#alice",
    "https://mewmo.example/api#alice",
  ]);
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.disable).not.toHaveBeenCalled();
});

it("still binds a new owner and explicitly clears on sign-out after expiry", async () => {
  await alarms.bindAlarmAccount("alice", "https://mewmo.example/api");
  alarms.suspendAlarmAccount();
  await alarms.bindAlarmAccount("bob", "https://mewmo.example/api");
  expect(mocks.bind.mock.lastCall?.[0].owner).toBe(
    "https://mewmo.example/api#bob",
  );
  expect(alarms.alarmSnapshot().enabled).toBe(false);
  alarms.suspendAlarmAccount();
  await alarms.bindAlarmAccount(null);
  expect(mocks.bind.mock.lastCall?.[0].owner).toBeNull();
});

it("keeps an intentionally disabled alarm preference disabled after renewal", async () => {
  await alarms.bindAlarmAccount("alice");
  await alarms.disableAlarms();
  alarms.suspendAlarmAccount();
  await alarms.bindAlarmAccount("alice");
  expect(alarms.alarmSnapshot().enabled).toBe(false);
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.bind.mock.calls.map(([call]) => call.owner)).toEqual([
    "#alice",
    "#alice",
  ]);
});

it("discards queued alarm mutations when the session expires", async () => {
  await alarms.bindAlarmAccount("alice");
  const pending = alarms.syncAlarms([item]);
  const rejected = expect(pending).rejects.toThrow("Account changed");
  alarms.suspendAlarmAccount();
  await rejected;
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.bind).toHaveBeenCalledTimes(1);
});

it("does not publish an already-dispatched native result after expiry", async () => {
  await alarms.bindAlarmAccount("alice");
  let finish!: (result: typeof enabled) => void;
  mocks.sync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = alarms.syncAlarms([item]);
  const rejected = expect(pending).rejects.toThrow("Account changed");
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalled());
  alarms.suspendAlarmAccount();
  finish(enabled);
  await rejected;
  expect(alarms.alarmSnapshot()).toEqual(unavailable);
  expect(mocks.bind).toHaveBeenCalledTimes(1);
});

it.each(["sync", "authorize", "disable"] as const)(
  "does not begin %s after expiry during a binding retry",
  async (operation) => {
    mocks.bind.mockRejectedValueOnce(new Error("temporary bridge error"));
    await expect(alarms.bindAlarmAccount("alice")).rejects.toThrow();
    let finish!: (result: typeof enabled) => void;
    mocks.bind.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending =
      operation === "sync"
        ? alarms.syncAlarms([item])
        : operation === "authorize"
          ? alarms.authorizeAlarms()
          : alarms.disableAlarms();
    const rejected = expect(pending).rejects.toThrow("Account changed");
    await vi.waitFor(() => expect(mocks.bind).toHaveBeenCalledTimes(2));
    alarms.suspendAlarmAccount();
    finish(enabled);
    await rejected;
    expect(mocks[operation]).not.toHaveBeenCalled();
    expect(alarms.alarmSnapshot()).toEqual(unavailable);
  },
);

it("reports native failure instead of claiming an alarm is scheduled", async () => {
  await alarms.bindAlarmAccount("alice");
  mocks.sync.mockRejectedValueOnce(new Error("private native failure"));
  await expect(alarms.syncAlarms([item])).rejects.toThrow();
  expect(alarms.alarmMessage(item)).toBe(
    "Could not update iPhone alarms. Existing alarms may still ring.",
  );
  expect(JSON.stringify(alarms.alarmSnapshot())).not.toContain(
    "private native",
  );
});

it("rejects invalid dates before native side effects", async () => {
  await alarms.bindAlarmAccount("alice");
  await expect(
    alarms.syncAlarms([{ ...item, due_at: "invalid" }]),
  ).rejects.toThrow();
  expect(mocks.sync).not.toHaveBeenCalled();
});

it.each([
  ["scheduled", "Alarm scheduled"],
  ["alerting", "ringing"],
  ["not_scheduled", "removed"],
  ["limit", "alarm limit"],
  ["failed", "Could not schedule"],
  ["past", "already passed"],
  ["ended", "still open"],
])(
  "explains native %s status without marking push sent",
  async (state, expected) => {
    await alarms.bindAlarmAccount("alice");
    mocks.sync.mockResolvedValue({ ...enabled, states: { [item.id]: state } });
    await alarms.syncAlarms([item]);
    expect(alarms.alarmMessage(item)).toContain(expected);
  },
);

const earlyId = "00000000-0000-5000-8000-000000000003";
const dual = { ...item, early_alarm_id: earlyId };

it("schedules due and one-hour alarms with independent stable IDs and sanitized titles", async () => {
  await alarms.bindAlarmAccount("alice");
  await alarms.syncAlarms([dual], { force: true });
  const records = mocks.sync.mock.lastCall![0].items;
  expect(records.map((r: { id: string }) => r.id)).toEqual([item.id, earlyId]);
  expect(records[0].fireAt - records[1].fireAt).toBe(3600);
  expect(records[1].title).toBe("In 1 hour: Turn off gas");
  expect(records.every((r: { active: boolean }) => r.active)).toBe(true);
  expect(JSON.stringify(records)).not.toContain("$120");
  await alarms.syncAlarms([{ ...dual, due_at: "2099-11-10T05:38:00Z" }]);
  expect(
    mocks.sync.mock.lastCall![0].items.map((r: { id: string }) => r.id),
  ).toEqual([item.id, earlyId]);
});

it("cancels both alarm IDs for partial completion, deletion, and urgency-off updates", async () => {
  await alarms.bindAlarmAccount("alice");
  for (const changed of [
    { ...dual, status: "completed" as const },
    { ...dual, status: "paid" as const },
    { ...dual, urgent: false },
  ]) {
    await alarms.syncAlarms([changed]);
    expect(mocks.sync.mock.lastCall![0].items).toHaveLength(2);
    expect(
      mocks.sync.mock.lastCall![0].items.every(
        (r: { active: boolean }) => !r.active,
      ),
    ).toBe(true);
  }
});

it("keeps due status independent when the early alarm hits its limit or is dismissed", async () => {
  await alarms.bindAlarmAccount("alice");
  for (const status of ["limit", "ended"]) {
    const state = {
      ...enabled,
      authorization: "authorized" as const,
      states: { [item.id]: "scheduled", [earlyId]: status },
    };
    expect(alarms.alarmMessage(dual, state)).toContain("Alarm scheduled");
    expect(alarms.alarmMessage(dual, state, true)).toContain(
      status === "limit" ? "alarm limit" : "ended",
    );
  }
});

it("leaves past-time handling to native without cancelling an unchanged ringing early alarm", async () => {
  await alarms.bindAlarmAccount("alice");
  const soon = {
    ...dual,
    due_at: new Date(Date.now() + 5 * 60000).toISOString(),
  };
  await alarms.syncAlarms([soon]);
  const records = mocks.sync.mock.lastCall![0].items;
  expect(records[1].fireAt * 1000).toBeLessThan(Date.now());
  expect(records[1].active).toBe(true);
  const state = { ...enabled, authorization: "authorized" as const };
  expect(alarms.alarmMessage(soon, state, true)).toContain(
    "that time has already passed",
  );
  expect(
    alarms.alarmMessage(
      soon,
      { ...state, states: { [earlyId]: "alerting" } },
      true,
    ),
  ).toContain("ringing");
});

it("explains older server limitations and never uses private raw titles for early alarms", async () => {
  await alarms.bindAlarmAccount("alice");
  const state = { ...enabled, authorization: "authorized" as const };
  expect(alarms.alarmMessage(item, state, true)).toContain("Update the server");
  await alarms.syncAlarms([{ ...dual, alarm_title: undefined }]);
  expect(mocks.sync.mock.lastCall![0].items[1].title).toBe(
    "In 1 hour: Mewmo reminder",
  );
  await alarms.syncAlarms([{ ...dual, alarm_title: "中".repeat(180) }]);
  expect(Array.from(mocks.sync.mock.lastCall![0].items[1].title)).toHaveLength(
    180,
  );
});
