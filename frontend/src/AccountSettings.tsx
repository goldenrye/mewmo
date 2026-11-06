import { useEffect, useState } from "react";
import { Copy, Link, ShieldCheck } from "lucide-react";
import { api } from "./api";
import type { Account, Invitation } from "./types";

export function AccountSettings({ account }: { account: Account }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/password", {
        method: "POST",
        body: JSON.stringify({
          current_password: current,
          new_password: password,
        }),
      });
      setCurrent("");
      setPassword("");
      setConfirmation("");
      setMessage("Password updated. Other sessions have been signed out.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-grid account-settings">
      <section className="settings-card account-card">
        <ShieldCheck size={25} />
        <h2>Your account</h2>
        <p className="muted">
          {account.user.display_name} · @{account.user.username}
        </p>
        <p className="muted">
          Your bills, history, and devices are private to your account.
          Administrators can invite people, but cannot view their items through
          the app.
        </p>
        <form onSubmit={changePassword}>
          <h3>Change password</h3>
          <label>
            Current password
            <input
              type="password"
              required
              autoComplete="current-password"
              maxLength={512}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={12}
              maxLength={512}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={12}
              maxLength={512}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <p className="muted small">Use at least 12 characters.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          <button className="secondary" disabled={busy}>
            {busy ? "Updating..." : "Update password"}
          </button>
        </form>
      </section>
      {account.user.is_admin && <Invitations />}
    </div>
  );
}

function Invitations() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [link, setLink] = useState<(Invitation & { url: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  async function refresh() {
    setInvitations(await api<Invitation[]>("/admin/invitations"));
  }
  useEffect(() => {
    let live = true;
    const load = () =>
      api<Invitation[]>("/admin/invitations")
        .then((rows) => {
          if (live) setInvitations(rows);
        })
        .catch((error) => {
          if (live) setError(error.message);
        });
    void load();
    const timer = setInterval(load, 60000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  async function create() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      setLink(
        await api<Invitation & { url: string }>("/admin/invitations", {
          method: "POST",
        }),
      );
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/admin/invitations/${id}`, { method: "DELETE" });
      if (link?.id === id) setLink(null);
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card account-card">
      <Link size={25} />
      <h2>Invite people</h2>
      <p className="muted">
        Administrator only. Each link creates one personal account and expires 7
        days after creation. Share it privately with the intended person.
      </p>
      <button className="primary" disabled={busy} onClick={() => void create()}>
        <Link size={16} /> {busy ? "Please wait..." : "Create invite link"}
      </button>
      {link && (
        <div className="invite-result">
          <label>
            Invitation link
            <input
              readOnly
              value={link.url}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <p className="small muted">
            Expires {new Date(link.expires_at).toLocaleString()}. This link is
            shown only here; copy it before leaving this page.
          </p>
          <button
            className="secondary"
            onClick={() => {
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(link.url))
                .then(() => setCopied(true))
                .catch(() =>
                  setError(
                    "Clipboard unavailable. Select the invitation link to copy it.",
                  ),
                );
            }}
          >
            <Copy size={16} />
            {copied ? "Copied" : "Copy invite link"}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3 className="device-title">Recent invitations</h3>
      {!invitations.length && (
        <p className="empty-inline">No invitations yet.</p>
      )}
      {invitations.map((invitation) => (
        <div className="delivery-row invitation-row" key={invitation.id}>
          <div>
            <strong>Invitation {invitation.id.slice(0, 8)}</strong>
            <small>
              Expires {new Date(invitation.expires_at).toLocaleString()}
            </small>
          </div>
          <span className="status-pill">{invitation.status}</span>
          {invitation.status === "pending" && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void revoke(invitation.id)}
            >
              Revoke
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
