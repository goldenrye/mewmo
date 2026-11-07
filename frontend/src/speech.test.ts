import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { speechError, startSpeech, supportsSpeech } from "./speech";

const native = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  isPluginAvailable: vi.fn(() => true),
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  addListener: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: native,
  registerPlugin: () => native,
}));
class Recognition {
  static current: Recognition;
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: null | (() => void) = null;
  onresult: null | ((event: { results: { transcript: string }[][] }) => void) =
    null;
  onerror: null | ((event: { error: string }) => void) = null;
  onend: null | (() => void) = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    Recognition.current = this;
  }
}
function callbacks() {
  return {
    listening: vi.fn(),
    partial: vi.fn(),
    done: vi.fn(),
    error: vi.fn(),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  native.isNativePlatform.mockReturnValue(false);
  native.cancel.mockResolvedValue(undefined);
  native.stop.mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    isSecureContext: true,
    SpeechRecognition: Recognition,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("requires a secure browser with speech support", () => {
  expect(supportsSpeech()).toBe(true);
  vi.stubGlobal("window", {
    isSecureContext: false,
    SpeechRecognition: Recognition,
  });
  expect(supportsSpeech()).toBe(false);
  vi.stubGlobal("window", { isSecureContext: true });
  expect(supportsSpeech()).toBe(false);
});

it("replaces interim results rather than duplicating them, and returns text on stop", () => {
  const cb = callbacks();
  const session = startSpeech("zh-CN", cb);
  const rec = Recognition.current;
  expect(rec.lang).toBe("zh-CN");
  expect(cb.listening).toHaveBeenCalledOnce();
  rec.onresult?.({ results: [[{ transcript: "后天9点" }]] });
  rec.onresult?.({ results: [[{ transcript: "后天9点有医生预约" }]] });
  session.stop();
  expect(cb.done).toHaveBeenCalledExactlyOnceWith("后天9点有医生预约");
  expect(rec.abort).toHaveBeenCalledOnce();
  expect(rec.onresult).toBeNull();
});

it("cancellation ignores late results and never returns a transcript", () => {
  const cb = callbacks();
  const session = startSpeech("en-US", cb);
  const rec = Recognition.current;
  const late = rec.onresult!;
  session.cancel();
  late({ results: [[{ transcript: "private reminder" }]] });
  expect(cb.partial).not.toHaveBeenCalled();
  expect(cb.done).not.toHaveBeenCalled();
  expect(rec.abort).toHaveBeenCalledOnce();
});

it("stops listening after 60 seconds", () => {
  const cb = callbacks();
  startSpeech("en-US", cb);
  Recognition.current.onresult?.({
    results: [[{ transcript: "Dentist tomorrow" }]],
  });
  vi.advanceTimersByTime(60_000);
  expect(Recognition.current.stop).toHaveBeenCalledOnce();
  expect(cb.done).toHaveBeenCalledWith("Dentist tomorrow");
});

it("aborts a stalled stop and still returns the last transcript", () => {
  const cb = callbacks();
  const session = startSpeech("en-US", cb);
  Recognition.current.stop.mockImplementation(() => {});
  Recognition.current.onresult?.({ results: [[{ transcript: "Dentist" }]] });
  session.stop();
  vi.advanceTimersByTime(4_000);
  expect(cb.done).toHaveBeenCalledWith("Dentist");
  expect(Recognition.current.abort).toHaveBeenCalled();
});

it.each(["not-allowed", "network", "no-speech", "audio-capture"])(
  "reports %s and releases recognition",
  (code) => {
    const cb = callbacks();
    startSpeech("en-US", cb);
    Recognition.current.onerror?.({ error: code });
    expect(cb.error).toHaveBeenCalledWith(speechError(code));
    expect(cb.done).not.toHaveBeenCalled();
    expect(Recognition.current.abort).toHaveBeenCalled();
  },
);

it("native setup uses the selected language and removes its scoped listener", async () => {
  native.isNativePlatform.mockReturnValue(true);
  const remove = vi.fn().mockResolvedValue(undefined);
  native.addListener.mockResolvedValue({ remove });
  native.start.mockResolvedValue({ text: "后天9点有医生预约" });
  const cb = callbacks();
  startSpeech("zh-CN", cb);
  await vi.waitFor(() =>
    expect(cb.done).toHaveBeenCalledWith("后天9点有医生预约"),
  );
  expect(native.start).toHaveBeenCalledWith({
    language: "zh-CN",
    requestId: expect.any(String),
  });
  expect(remove).toHaveBeenCalledOnce();
});

it("cancelling before native listener setup completes never starts the microphone", async () => {
  native.isNativePlatform.mockReturnValue(true);
  let resolve!: (value: { remove: () => Promise<void> }) => void;
  native.addListener.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const cb = callbacks();
  const session = startSpeech("en-US", cb);
  session.cancel();
  const remove = vi.fn().mockResolvedValue(undefined);
  resolve({ remove });
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
  expect(native.start).not.toHaveBeenCalled();
  expect(cb.done).not.toHaveBeenCalled();
});

it("ignores native events from other sessions and late results after cancellation", async () => {
  native.isNativePlatform.mockReturnValue(true);
  const remove = vi.fn().mockResolvedValue(undefined);
  native.addListener.mockResolvedValue({ remove });
  let resolve!: (value: { text: string }) => void;
  native.start.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const cb = callbacks();
  const session = startSpeech("en-US", cb);
  await vi.waitFor(() => expect(native.start).toHaveBeenCalledOnce());
  const id = native.start.mock.calls[0][0].requestId;
  const partial = native.addListener.mock.calls[0][1];
  partial({ requestId: "another-session", text: "Other user" });
  expect(cb.partial).not.toHaveBeenCalled();
  partial({ requestId: id, text: "My draft" });
  expect(cb.partial).toHaveBeenCalledWith("My draft");
  session.cancel();
  resolve({ text: "Late private transcript" });
  await Promise.resolve();
  expect(cb.done).not.toHaveBeenCalled();
  expect(native.cancel).toHaveBeenCalledWith({ requestId: id });
});

it("aborts recognition if the system never starts", () => {
  class PendingRecognition extends Recognition {
    start = vi.fn();
  }
  vi.stubGlobal("window", {
    isSecureContext: true,
    SpeechRecognition: PendingRecognition,
  });
  const cb = callbacks();
  startSpeech("en-US", cb);
  vi.advanceTimersByTime(90_000);
  expect(cb.error).toHaveBeenCalled();
  expect(Recognition.current.abort).toHaveBeenCalledOnce();
});
