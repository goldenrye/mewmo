import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mic } from "lucide-react";
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
  const [cancelling, setCancelling] = useState(false);
  const [tapMode, setTapMode] = useState(false);
  const session = useRef<SpeechSession | null>(null);
  const ready = useRef(false);
  const gesture = useRef<
    | { kind: "pointer"; id: number; y: number; cancel: boolean }
    | { kind: "keyboard"; key: string }
    | { kind: "virtual" }
    | null
  >(null);
  const generation = useRef(0);
  const busyCallback = useRef(onBusy);
  const textCallback = useRef(onText);
  busyCallback.current = onBusy;
  textCallback.current = onText;
  const active = state !== "idle";

  function cancel(discard = session.current !== null) {
    generation.current++;
    gesture.current = null;
    ready.current = false;
    session.current?.cancel();
    session.current = null;
    setCancelling(false);
    setTapMode(false);
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
    window.addEventListener("blur", leave);
    window.addEventListener("keydown", escape);
    return () => {
      generation.current++;
      if (session.current) textCallback.current("");
      session.current?.cancel();
      busyCallback.current(false);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("blur", leave);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);

  function start() {
    if (disabled || session.current) return;
    const id = ++generation.current;
    ready.current = false;
    setError("");
    // Opening audio handles scrolling. Do not move the control under a held finger.
    textCallback.current("");
    setState("starting");
    busyCallback.current(true);
    session.current = startSpeech(language, {
      listening() {
        if (id === generation.current) {
          ready.current = true;
          setState("listening");
        }
      },
      partial(value) {
        if (id === generation.current) textCallback.current(value);
      },
      done(value) {
        if (id !== generation.current) return;
        gesture.current = null;
        session.current = null;
        setCancelling(false);
        setTapMode(false);
        textCallback.current(value);
        setState("idle");
        setOpen(false);
        busyCallback.current(false);
      },
      error(message) {
        if (id !== generation.current) return;
        gesture.current = null;
        session.current = null;
        setCancelling(false);
        setTapMode(false);
        setError(message);
        textCallback.current("");
        setState("idle");
        busyCallback.current(false);
      },
    });
  }

  function finish(discard = false) {
    gesture.current = null;
    setCancelling(false);
    if (discard || !ready.current) {
      cancel(true);
      return;
    }
    setState("stopping");
    session.current?.stop();
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
              <p className="muted voice-privacy">
                {t(
                  "System speech may process audio online. Mewmo does not store recordings.",
                )}
              </p>
              <div className="voice-controls">
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
                <p role="status" className="voice-status">
                  {t(
                    cancelling
                      ? "Release to cancel"
                      : state === "starting"
                        ? "Starting microphone..."
                        : state === "stopping"
                          ? "Finishing transcript..."
                          : tapMode
                            ? "Tap again to finish. Speak for up to 60 seconds."
                            : "Slide up to cancel. Up to 60 seconds.",
                  )}
                </p>
                <div className="voice-actions">
                  <button
                    type="button"
                    className={`voice-hold ${active ? "is-recording" : ""} ${cancelling ? "is-cancelling" : ""}`}
                    aria-label={t("Hold to speak")}
                    aria-pressed={active}
                    disabled={disabled || state === "stopping"}
                    onContextMenu={(event) => event.preventDefault()}
                    onPointerDown={(event) => {
                      if (
                        event.button !== 0 ||
                        !event.isPrimary ||
                        active ||
                        gesture.current
                      )
                        return;
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      gesture.current = {
                        kind: "pointer",
                        id: event.pointerId,
                        y: event.clientY,
                        cancel: false,
                      };
                      setTapMode(false);
                      start();
                    }}
                    onPointerMove={(event) => {
                      const held = gesture.current;
                      if (
                        held?.kind !== "pointer" ||
                        held.id !== event.pointerId
                      )
                        return;
                      held.cancel = held.y - event.clientY >= 64;
                      setCancelling(held.cancel);
                    }}
                    onPointerUp={(event) => {
                      const held = gesture.current;
                      if (
                        held?.kind !== "pointer" ||
                        held.id !== event.pointerId
                      )
                        return;
                      finish(held.cancel || held.y - event.clientY >= 64);
                    }}
                    onPointerCancel={(event) => {
                      if (
                        gesture.current?.kind === "pointer" &&
                        gesture.current.id === event.pointerId
                      )
                        cancel(true);
                    }}
                    onLostPointerCapture={(event) => {
                      if (
                        gesture.current?.kind === "pointer" &&
                        gesture.current.id === event.pointerId
                      )
                        cancel(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== " " && event.key !== "Enter") return;
                      event.preventDefault();
                      if (event.repeat || active || gesture.current) return;
                      gesture.current = { kind: "keyboard", key: event.key };
                      setTapMode(false);
                      start();
                    }}
                    onKeyUp={(event) => {
                      if (event.key !== " " && event.key !== "Enter") return;
                      event.preventDefault();
                      if (
                        gesture.current?.kind === "keyboard" &&
                        gesture.current.key === event.key
                      )
                        finish();
                    }}
                    onBlur={() => {
                      if (gesture.current) cancel(true);
                    }}
                    onClick={(event) => {
                      // Assistive activation has no pointer/key hold. Use the same control to finish.
                      if (event.detail !== 0) return;
                      if (gesture.current?.kind === "virtual") finish();
                      else if (!active && !gesture.current) {
                        gesture.current = { kind: "virtual" };
                        setTapMode(true);
                        start();
                      }
                    }}
                  >
                    <Mic size={20} aria-hidden="true" />
                    {t(
                      cancelling
                        ? "Release to cancel"
                        : state === "stopping"
                          ? "Finishing transcript..."
                          : active
                            ? tapMode
                              ? "Tap to finish"
                              : "Release to finish"
                            : "Hold to speak",
                    )}
                  </button>
                </div>
              </div>
              {aiEnabled && (
                <p className="muted voice-privacy voice-followup">
                  {t("AI helps interpret your text when you preview.")}
                </p>
              )}
              {error && (
                <p className="error voice-followup" role="alert">
                  {t(error)}
                </p>
              )}
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
