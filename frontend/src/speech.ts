import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";

type ResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: ResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
interface NativeSpeech {
  start(options: {
    language: string;
    requestId: string;
  }): Promise<{ text: string }>;
  stop(options: { requestId: string }): Promise<void>;
  cancel(options: { requestId: string }): Promise<void>;
  addListener(
    name: "partial",
    callback: (event: { requestId: string; text: string }) => void,
  ): Promise<PluginListenerHandle>;
}
const native = registerPlugin<NativeSpeech>("MewmoSpeech");
function constructor() {
  const win = window as SpeechWindow;
  return win.SpeechRecognition || win.webkitSpeechRecognition;
}
export function supportsSpeech() {
  return Capacitor.isNativePlatform()
    ? Capacitor.isPluginAvailable("MewmoSpeech")
    : window.isSecureContext && !!constructor();
}
export function speechError(code: string) {
  if (["not-allowed", "service-not-allowed", "PERMISSION"].includes(code))
    return "Microphone or speech permission was denied. Allow access in device or browser settings, or type your reminder.";
  if (["no-speech", "NO_SPEECH"].includes(code))
    return "No speech was recognized. Try again or type your reminder.";
  if (code === "network")
    return "Speech recognition could not connect. Check your connection or type your reminder.";
  return "Speech recognition is unavailable. Try again or use keyboard dictation.";
}
export interface SpeechSession {
  stop(): void;
  cancel(): void;
}
export interface SpeechCallbacks {
  listening(): void;
  partial(text: string): void;
  done(text: string): void;
  error(message: string): void;
}

// Audio belongs to system speech services. This adapter never records or uploads audio.
export function startSpeech(
  language: string,
  callbacks: SpeechCallbacks,
): SpeechSession {
  let settled = false;
  let listening = false;
  let stopping = false;
  let latest = "";
  let recognizer: Recognition | undefined;
  let listener: PluginListenerHandle | undefined;
  const nativeMode = Capacitor.isNativePlatform();
  const requestId = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout>;
  function cleanup() {
    clearTimeout(timer);
    if (recognizer) {
      recognizer.onstart =
        recognizer.onresult =
        recognizer.onerror =
        recognizer.onend =
          null;
      try {
        recognizer.abort();
      } catch {
        /* Already stopped. */
      }
    }
    void listener?.remove().catch(() => {});
    if (nativeMode) void native.cancel({ requestId }).catch(() => {});
  }
  function finish(error?: string) {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) callbacks.error(speechError(error));
    else if (!latest.trim()) callbacks.error(speechError("no-speech"));
    else callbacks.done(latest.trim());
  }
  function began() {
    if (settled || listening || stopping) return;
    listening = true;
    clearTimeout(timer);
    timer = setTimeout(() => session.stop(), 60_000);
    callbacks.listening();
  }
  const session: SpeechSession = {
    stop() {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      timer = setTimeout(() => finish(), 4_000);
      if (nativeMode)
        void native.stop({ requestId }).catch(() => finish("unavailable"));
      else
        try {
          recognizer?.stop();
        } catch {
          finish();
        }
    },
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
  timer = setTimeout(() => finish("unavailable"), 90_000);
  if (nativeMode) {
    void (async () => {
      listener = await native.addListener("partial", (event) => {
        if (settled || event.requestId !== requestId) return;
        began();
        latest = event.text;
        callbacks.partial(latest);
      });
      if (settled || stopping) {
        await listener.remove();
        if (!settled) finish();
        return;
      }
      const result = await native.start({ language, requestId });
      if (!settled) {
        latest = result.text;
        finish();
      }
    })().catch((error: { code?: string }) => {
      if (!settled) finish(error.code || "unavailable");
    });
  } else {
    try {
      const Constructor = constructor();
      if (!window.isSecureContext || !Constructor) throw new Error();
      recognizer = new Constructor();
      recognizer.lang = language;
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.onstart = began;
      recognizer.onresult = (event) => {
        if (settled) return;
        latest = Array.from(
          event.results,
          (result) => result[0]?.transcript || "",
        ).join(" ");
        callbacks.partial(latest);
      };
      recognizer.onerror = (event) => finish(event.error);
      recognizer.onend = () => finish();
      recognizer.start();
    } catch {
      queueMicrotask(() => finish("unavailable"));
    }
  }
  return session;
}
