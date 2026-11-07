import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { getLocale, t } from "./i18n";
import { startSpeech, supportsSpeech, type SpeechSession } from "./speech";

export function VoiceInput({
  disabled,
  aiEnabled,
  onUse,
  onBusy,
}: {
  disabled: boolean;
  aiEnabled: boolean;
  onUse: (text: string) => boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState(getLocale());
  const [state, setState] = useState<
    "idle" | "starting" | "listening" | "stopping"
  >("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const session = useRef<SpeechSession | null>(null);
  const generation = useRef(0);
  const busyCallback = useRef(onBusy);
  busyCallback.current = onBusy;
  const active = state !== "idle";

  function cancel() {
    generation.current++;
    session.current?.cancel();
    session.current = null;
    setState("idle");
    setTranscript("");
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
    window.addEventListener("pagehide", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      generation.current++;
      session.current?.cancel();
      busyCallback.current(false);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", cancel);
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
    setTranscript("");
    setState("starting");
    onBusy(true);
    session.current = startSpeech(language, {
      listening() {
        if (id === generation.current) setState("listening");
      },
      partial(value) {
        if (id === generation.current) setTranscript(value);
      },
      done(value) {
        if (id !== generation.current) return;
        session.current = null;
        setTranscript(value);
        setState("idle");
        onBusy(false);
      },
      error(message) {
        if (id !== generation.current) return;
        session.current = null;
        setError(message);
        setTranscript("");
        setState("idle");
        onBusy(false);
      },
    });
  }
  return (
    <div className="voice-input">
      <button
        type="button"
        className="voice-trigger"
        disabled={disabled || active}
        aria-expanded={open}
        onClick={() => {
          setLanguage(getLocale());
          setOpen(!open);
        }}
      >
        <Mic size={18} /> {t("Speak a reminder")}
      </button>
      {open && (
        <section className="voice-panel" aria-label={t("Voice input")}>
          {!supportsSpeech() ? (
            <p role="status">
              {t(
                "Speech recognition is unavailable here. Use keyboard dictation or type your reminder.",
              )}
            </p>
          ) : (
            <>
              <p className="muted">
                {t(
                  "Your device or browser speech service may process audio online. Mewmo does not store recordings. Review the transcript before previewing a draft.",
                )}
              </p>
              {aiEnabled && (
                <p className="muted">
                  {t(
                    "AI assistance is on. Your transcript will be sent to your selected model only when you preview the draft.",
                  )}
                </p>
              )}
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
              {(active || transcript) && (
                <label>
                  {t("Transcript")}
                  <textarea
                    aria-label={t("Transcript")}
                    rows={3}
                    value={transcript}
                    readOnly={active}
                    maxLength={4000}
                    onChange={(event) => setTranscript(event.target.value)}
                  />
                </label>
              )}
              {error && (
                <p className="error" role="alert">
                  {t(error)}
                </p>
              )}
              <div className="voice-actions">
                {!active && (
                  <button type="button" className="secondary" onClick={start}>
                    {t(transcript ? "Record again" : "Start listening")}
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
                {!active && transcript.trim() && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      if (onUse(transcript.trim())) cancel();
                    }}
                  >
                    {t("Use transcript")}
                  </button>
                )}
              </div>
            </>
          )}
          <button type="button" className="text-button" onClick={cancel}>
            {t("Cancel voice input")}
          </button>
        </section>
      )}
    </div>
  );
}
