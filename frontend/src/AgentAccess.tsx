import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { getLocale, messageText, t } from "./i18n";

type AgentToken = {
  id: string;
  name: string;
  expires_at: string;
  status: "active" | "expired" | "revoked";
};
type Access = { endpoint: string; tokens: AgentToken[] };
type Issued = AgentToken & { token: string; endpoint: string };

export function AgentAccess() {
  const [access, setAccess] = useState<Access | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const live = useRef(true);
  const expanded = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function refresh() {
    try {
      const value = await api<Access>("/agent-tokens");
      if (live.current) setAccess(value);
    } catch (error) {
      if (live.current) setError((error as Error).message);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setIssued(null);
    setCopied(false);
    try {
      const token = await api<Issued>("/agent-tokens", {
        method: "POST",
        body: JSON.stringify({ name, expires_days: Number(days) }),
      });
      if (live.current && expanded.current) {
        setIssued(token);
        setName("");
      }
      await refresh();
    } catch (error) {
      if (live.current) setError((error as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/agent-tokens/${id}`, { method: "DELETE" });
      if (live.current && issued?.id === id) setIssued(null);
      await refresh();
    } catch (error) {
      if (live.current) setError((error as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return (
    <section className="settings-card account-card">
      <h2>{t("Agent access")}</h2>
      <p className="muted">
        {t("Let trusted agents add reminders through remote MCP.")}
      </p>
      <details
        className="disclosure"
        onToggle={(event) => {
          expanded.current = event.currentTarget.open;
          if (expanded.current) void refresh();
          else {
            setIssued(null);
            setCopied(false);
          }
        }}
      >
        <summary>{t("Manage agent access")}</summary>
        <p className="muted small">
          {t(
            "Reminder creation only. No access to notes, account settings, or editing existing items. Keep token access limited to trusted agents.",
          )}
        </p>
        {access && (
          <label>
            {t("MCP endpoint")}
            <input
              readOnly
              value={access.endpoint}
              onFocus={(event) => event.target.select()}
            />
          </label>
        )}
        <p className="muted small">
          {t(
            "Use Streamable HTTP with an Authorization: Bearer token header. OAuth-only clients are not supported.",
          )}
        </p>
        <form onSubmit={create}>
          <label>
            {t("Agent name")}
            <input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("Token lifetime")}
            <select
              value={days}
              onChange={(event) => setDays(event.target.value)}
            >
              <option value="7">{t("7 days")}</option>
              <option value="30">{t("30 days")}</option>
              <option value="90">{t("90 days")}</option>
            </select>
          </label>
          <button className="primary" disabled={busy || !access}>
            {busy ? t("Please wait...") : t("Create agent token")}
          </button>
        </form>
        {issued && (
          <div className="invite-result">
            <label>
              {t("Agent token (shown once)")}
              <input
                readOnly
                autoComplete="off"
                value={issued.token}
                onFocus={(event) => event.target.select()}
              />
            </label>
            <p className="muted small">
              {t(
                "Copy this secret before closing. It cannot be shown again. Do not paste it into chat or commit it to code.",
              )}
            </p>
            <button
              className="secondary"
              onClick={() => {
                void Promise.resolve()
                  .then(() => navigator.clipboard.writeText(issued.token))
                  .then(() => {
                    if (live.current) setCopied(true);
                  })
                  .catch(() => {
                    if (live.current)
                      setError(
                        t(
                          "Clipboard unavailable. Select the token to copy it.",
                        ),
                      );
                  });
              }}
            >
              {copied ? t("Copied") : t("Copy agent token")}
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {messageText(error)}
          </p>
        )}
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            setError("");
            void refresh();
          }}
        >
          {t("Refresh agent tokens")}
        </button>
        {access?.tokens.map((token) => (
          <div className="delivery-row invitation-row" key={token.id}>
            <div>
              <strong>{token.name}</strong>
              <small>
                {t("Expires {date}", {
                  date: new Date(token.expires_at).toLocaleString(getLocale()),
                })}
              </small>
            </div>
            <span className="status-pill">{t(token.status)}</span>
            {token.status === "active" && (
              <button
                className="text-button"
                disabled={busy}
                aria-label={t("Revoke agent {name}", { name: token.name })}
                onClick={() => void revoke(token.id)}
              >
                {t("Revoke")}
              </button>
            )}
          </div>
        ))}
      </details>
    </section>
  );
}
