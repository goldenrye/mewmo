import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mic, Square } from "lucide-react";
import { getLocale, t } from "./i18n";
import { startSpeech, supportsSpeech, type SpeechSession } from "./speech";

export function VoiceInput({
  disabled,
  aiEnabled,
  onText,
  onReset,
  onBusy,
  children,
  triggerLabel = "Add a reminder by audio",
  unavailableLabel = "Speech recognition is unavailable here. Use keyboard dictation or type your reminder.",
}: {
  disabled: boolean;
  aiEnabled: boolean;
  onText: (text: string) => void;
  onReset: () => void;
  onBusy: (busy: boolean) => void;
  children?: ReactNode;
  triggerLabel?: string;
  unavailableLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState(getLocale());
  const [state, setState] = useState<
    "idle" | "starting" | "listening" | "stopping"
  >("idle");
  const [error, setError] = useState("");
  const session = useRef<SpeechSession | null>(null);
  const generation = useRef(0);
  const busyCallback = useRef(onBusy);
  const textCallback = useRef(onText);
  busyCallback.current = onBusy;
  textCallback.current = onText;
  const active = state !== "idle";

  function cancel(discard = session.current !== null) {
    generation.current++;
    session.current?.cancel();
    session.current = null;
    setState("idle");
    if (discard) textCallback.current("");
    setError("");
    setOpen(false);
    busyCallback.current(false);
  }
  useEffect(() => {
    function hidden() {
      if (document.hidden) cancel();
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") cancel();
    }
    document.addEventListener("visibilitychange", hidden);
    const leave = () => cancel();
    window.addEventListener("pagehide", leave);
    window.addEventListener("keydown", escape);
    return () => {
      generation.current++;
      if (session.current) textCallback.current("");
      session.current?.cancel();
      busyCallback.current(false);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);

  function start() {
    if (disabled || session.current) return;
    const id = ++generation.current;
    setError("");
    onReset();
    setState("starting");
    onBusy(true);
    session.current = startSpeech(language, {
      listening() {
        if (id === generation.current) setState("listening");
      },
      partial(value) {
        if (id === generation.current) textCallback.current(value);
      },
      done(value) {
        if (id !== generation.current) return;
        session.current = null;
        textCallback.current(value);
        setState("idle");
        setOpen(false);
        onBusy(false);
      },
      error(message) {
        if (id !== generation.current) return;
        session.current = null;
        setError(message);
        textCallback.current("");
        setState("idle");
        onBusy(false);
      },
    });
  }
  return (
    <div className="voice-input">
      <div className="capture-footer capture-actions">
        {children}
        <button
          type="button"
          className="voice-trigger"
          disabled={disabled || active}
          aria-expanded={open}
          onClick={() => {
            if (open) {
              cancel();
              return;
            }
            onReset();
            setError("");
            setLanguage(getLocale());
            setOpen(true);
          }}
        >
          <Mic size={15} /> {t(triggerLabel)}
        </button>
      </div>
      {open && (
        <section className="voice-panel" aria-label={t("Voice input")}>
          {!supportsSpeech() ? (
            <p role="status">{t(unavailableLabel)}</p>
          ) : (
            <>
              {!active && (
                <p className="muted voice-privacy">
                  {t(
                    "System speech may process audio online. Mewmo does not store recordings.",
                  )}
                </p>
              )}
              {!active && aiEnabled && (
                <p className="muted voice-privacy">
                  {t("AI helps interpret your text when you preview.")}
                </p>
              )}
              <div className="voice-controls">
                {!active && (
                  <label>
                    {t("Speech language")}
                    <select
                      aria-label={t("Speech language")}
                      value={language}
                      disabled={active}
                      onChange={(event) =>
                        setLanguage(event.target.value as "en-US" | "zh-CN")
                      }
                    >
                      <option value="en-US">English</option>
                      <option value="zh-CN">中文（普通话）</option>
                    </select>
                  </label>
                )}
                {active && (
                  <p role="status">
                    {t(
                      state === "starting"
                        ? "Starting microphone..."
                        : state === "stopping"
                          ? "Finishing transcript..."
                          : "Listening... Speak for up to 60 seconds.",
                    )}
                  </p>
                )}
                {error && (
                  <p className="error" role="alert">
                    {t(error)}
                  </p>
                )}
                <div className="voice-actions">
                  {!active && (
                    <button type="button" className="secondary" onClick={start}>
                      {t("Start listening")}
                    </button>
                  )}
                  {active && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={state === "stopping"}
                      onClick={() => {
                        setState("stopping");
                        session.current?.stop();
                      }}
                    >
                      <Square size={16} />
                      {t("Stop listening")}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          <button
            type="button"
            className="text-button voice-cancel"
            onClick={() => cancel(true)}
          >
            {t("Cancel voice input")}
          </button>
        </section>
      )}
    </div>
  );
}
