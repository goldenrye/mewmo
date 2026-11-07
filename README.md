# Mewmo

An invite-only, multi-user bill and reminder app. Each person has a private account. Capture an item, review the draft, confirm it, get reminded, and stop reminders when it is handled.

## Stack

- FastAPI, SQLAlchemy 2, PostgreSQL 16, Alembic.
- React, TypeScript, Vite. The same UI runs on the web and in Capacitor 8 on iPhone.
- APNs for iPhone and Web Push for browsers.
- Local Poppler, Tesseract (English and simplified Chinese), and Pillow/HEIF decoding by default. Optional per-user AI assistance can send content to the user's selected provider with consent.
- A dedicated Docker Compose project, PostgreSQL container/volume, networks, credentials, and backup directory. Nothing mounts or connects to rental-mgmt.

## Implemented

- PDF and image import, including scanned PDFs and HEIC photos. Limits: 12 MB, 5 PDF pages, 25 megapixels.
- In-memory drafts with uncertain fields, manual fallback, possible duplicate warnings, and account-number redaction.
- Chinese/English/mixed text capture. iPhone voice input uses the system keyboard's dictation; no microphone control or permission.
- English and Simplified Chinese interfaces, with automatic device-language detection and a saved language selector.
- Optional per-user OpenAI, Anthropic, or Gemini model settings, encrypted API keys, connection testing, and per-import image consent.
- Full date, weekday, time, and IANA zone on every confirmation card.
- Manual create/edit/delete, overdue-first home, search, calendar, one-tap paid/completed, undo, and history.
- Editable reminder rules; each fire time has a database row and per-device delivery audit.
- A 60-second worker scan with retry, cancellation, rescheduling, and future-only restoration on undo.
- Username/password accounts, hashed/revocable sessions, origin checks, and login rate limits.
- Administrator-created, single-use invitation links that expire after seven days, with revocation and status tracking.
- Per-user items, history, duplicate detection, reminder audit, and notification devices. Administrators cannot read other users' items through the app.

Parsing is deliberately conservative, not an open-ended AI assistant. Common relative dates, explicit dates, weekdays, numeric Chinese month/day dates, Chinese times, and labelled invoice fields are supported. Ambiguous currencies and missing information require review. For example, `这个月水电 120 刀，已付` produces a paid bill draft with amount 120, a currency warning, and a missing due date to fill in. A statement about "this month" does not invent a deadline.

**Parsing never creates items or reminders.** Only a separate item request with `confirmed: true` writes an item. Drafts are neither stored in the database nor cached in browser storage.

### Local Bill Extraction

By default, bill import uses local OCR and deterministic field matching, with no LLM or external document service. It supports paired column headings such as `Due date / Amount due`, values on nearby lines, and repeated matching totals. Conflicting totals or dates stay blank; a candidate with an unreadable repeated label remains flagged for review.

Payees can come from explicit English/Chinese labels, short company-like headers, or phrases such as `valued Boost Mobile customer`. Inferred payees and titles always show **Check this**. Dollar symbols alone still require currency confirmation. File dates require an explicit year and unambiguous ordering: `NOV 12, 2026` works, while `11/12/2026` requires manual confirmation. Natural-language relative-date parsing is unchanged.

Matching stops at unrelated fields such as bill periods, previous balances, autopay, and card expiry. Scheduled autopay never marks a bill paid. Only the account's last four digits are returned; original files and OCR intermediates remain temporary. This is not a general document-understanding engine: blurry text, unfamiliar layouts, and logos without readable issuer text may still need manual entry.

Regression coverage includes a synthetic Boost-style OCR transcript yielding **Boost Mobile / 61.78 / November 12, 2026**, with the inferred payee and currency flagged. Generated two-column PNG/PDF/HEIF tests require Tesseract and Poppler; transcript tests do not prove extraction from a particular original image. This is a backend change: deploying the updated API enables it for both browser and iPhone imports without rebuilding the iPhone app.

## Optional AI Assistance

Open **Settings > AI assistance > Configure model**. Each user can save one provider, model ID, and API key. Supported APIs are OpenAI Chat Completions with JSON output, Anthropic Messages, and Google Gemini `generateContent`. Use a model available to your provider account; custom endpoints and local model servers are not supported. Keys are encrypted on the Mewmo server, never returned by the API, and never stored in browser storage. Leaving the key blank preserves it; changing providers requires a new key and fresh consent in the UI.

AI is **off by default**. Enabling it sends new typed input or extracted OCR text to that provider to suggest draft fields. Recognizable account numbers are redacted, but this is best-effort redaction, not anonymization: names, addresses, amounts, or other personal details may remain. Input is limited to the first 12,000 characters. There is no background processing of saved items, chat agent, automatic payment, or AI access to reminder dispatch or other accounts.

**Allow optional image analysis** makes a separate checkbox available on the capture card. Check it for each import that should send bill images to the provider; it resets after the attempt or leaving the page. Images can contain full account details and are not text-redacted. Mewmo strips metadata and converts images or up to five PDF pages to bounded PNGs (2,000-pixel maximum dimension, 8 MB total base64 payload); PDF conversion requires Poppler. Provider retention policies still apply even though Mewmo discards originals and intermediate files. A provider change invalidates pending image consent.

AI suggestions can fill missing or uncertain fields; they cannot overwrite confident local values silently. Disagreements are flagged for review. Model output is schema-validated and cannot supply payment status, account IDs, reminder rules, or actions. Imported bills stay open even if the document mentions autopay. Nothing is saved until the existing confirmation step. Timeouts, invalid output, unavailable models, and rate limits fall back to the local draft; if neither local parsing nor AI can extract a bill, manual entry is offered.

**Test saved model** sends only a synthetic request, can incur provider charges, and checks text/JSON connectivity, not vision support. Image analysis requires a vision-capable model. Use **Remove model** to delete the encrypted credential and revert to local-only capture. Disabling AI stops subsequent requests; it cannot recall requests already in flight or delete copies held by the provider. Provider usage is billed to the user's account. The app limits assistance to 30 requests and connection tests to 5 requests per user per five minutes, with four simultaneous provider calls per API process, a 30-second network timeout, and bounded responses.

### Server Setup

Before users can save keys, generate a Fernet encryption key using the backend environment:

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Set `LLM_ENCRYPTION_KEY` in the server's private `.env` (or `backend/.env` for local development). Never commit it. Keep it stable across restarts and store a backup separately from the database backups. Database backups contain encrypted provider credentials; restoring them without the same encryption key makes them unusable. There is no automatic key rotation: users must re-enter provider keys after changing or losing this key. Missing or invalid encryption configuration disables saving and provider calls, while local parsing and credential removal remain available.

Deploy the backend and web client using the existing upgrade procedure, including `alembic upgrade head` / the Compose `migrate` service. Migration `0003` adds a separate per-user settings table without enabling AI for existing users or changing their items. Rebuild/sync/reinstall the iPhone client for the new settings and consent controls. Do not place provider keys or `LLM_ENCRYPTION_KEY` in any `VITE_*` variable.

Automated tests use mocked provider responses and a disposable database; they do not make paid requests or prove compatibility with every provider model. Validate your selected model with the connection test and a non-sensitive sample before uploading a real bill.

## Language

Choose **Language → 简体中文** on the sign-in screen or under **Settings → Your account**. The default follows the device/browser language; Chinese language variants use Simplified Chinese, and unsupported languages fall back to English. The preference is saved per browser/iPhone installation, not to an account, and updates other open browser tabs.

The interface, accessibility labels, common validation/import errors, dates, delivery statuses, and Face ID prompts are localized. Switching language preserves open drafts and never translates your titles, payees, names, or account data; it also does not change currencies, time zones, schedules, or parsing rules. Unknown server errors retain their original text. Push notification date text remains server-formatted; this preference controls the client interface.

Native permission explanations are bundled in English and Simplified Chinese and follow the iOS app language. The Face ID reason follows Mewmo's selected language. Rebuild/reinstall the native app to include these resources; updating the website alone does not update the iPhone bundle.

## Local Development

Prerequisites: Python 3.12+, Node 22+ (Node 24 recommended), PostgreSQL 16+, and OCR tools.

```bash
# From backend/
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock
.venv/bin/pip install -e '.[test]'

# Install the local OCR commands (macOS):
brew install poppler tesseract tesseract-lang

# Generate a password hash. Store the output in backend/.env.
python3 ../scripts/hash_password.py
```

Example `backend/.env`, using a NEW Mewmo-only local database:

```dotenv
DATABASE_URL=postgresql+psycopg://mewmo:YOUR_URL_SAFE_PASSWORD@127.0.0.1:5432/mewmo
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH='scrypt$YOUR_SALT$YOUR_HASH'
PUBLIC_WEB_URL=http://localhost:5173
COOKIE_SECURE=false
CORS_ORIGINS=http://localhost:5173,capacitor://localhost
```

```bash
# From backend/, in separate terminals:
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
.venv/bin/python -m app.worker

# From frontend/:
npm ci
npm run dev
```

Open `http://localhost:5173` and sign in as `admin` with the password used to generate the hash. Vite proxies `/api` to FastAPI. The app starts with an empty list, not demo bills.

For an entirely disposable browser preview, `backend/tests/run_e2e.py` starts a SQLite-backed API on port 8000 with username `admin` and the **test-only** password `mewmo-local-test`. It removes its temporary database when stopped. This is not a production mode and does not run a reminder worker.

## Accounts and Invitations

The first migration to the multi-user schema creates an administrator named `admin` (override with `ADMIN_USERNAME` before migrating). It uses `ADMIN_PASSWORD_HASH`, or the existing `OWNER_PASSWORD_HASH` when upgrading an older installation. There is no default production password and no public signup. These environment settings bootstrap the account only; subsequent restarts or migrations do not reset its password.

As administrator, open **Settings > Invite people > Create invite link**. Copy the displayed link and share it privately. Each link:

- Expires exactly seven days after creation, using server time.
- Can create one ordinary user account, never another administrator.
- Is stored only as a hash; the full link is shown only when created.
- Can be revoked in Settings until it is used. Revoking an invite does not delete an existing account.

The recipient opens the link on the web, chooses a unique username and a password of at least 12 characters, and gets an empty private space. On iPhone, they can instead choose **Have an invitation? Create an account** and paste the link. Usernames are case-insensitive and allow 3-40 letters, digits, dots, underscores, or dashes. Users can change their password in Settings; doing so revokes their other sessions.

Set `PUBLIC_WEB_URL` to the exact web origin, including a custom HTTPS port if applicable. For this server, use `https://mewmo.rental-mgmt.us:9443`. Invitation tokens are in the URL fragment, not request paths or query strings. Anyone holding an unused invitation can redeem it, so do not post links publicly. Email delivery, email verification, and self-service forgotten-password recovery are not included.

### Upgrade an Existing Installation

Take and verify a Mewmo database backup first. Keep the current password hash, and add `PUBLIC_WEB_URL` to `.env`. Stop old API/worker processes before changing the schema; do not run old and new versions together:

```bash
docker compose stop web api worker
docker compose build
docker compose run --rm migrate
docker compose up -d
```

Migration `0002` assigns all existing items and device/delivery history to the administrator without deleting bills or reminder audit. It invalidates old sessions and disables old notification registrations, which did not have an installation binding. Sign in with username `admin` and your existing password, then re-enable notifications on each device. Rebuild/reinstall the iPhone client to get username sign-in.

Downgrading this migration is intentionally blocked: merging private accounts into one owner would disclose users' data. To roll back, restore a verified pre-upgrade backup and matching application version with the worker stopped.

## Production Deployment

1. Install Docker Engine and Docker Compose v2 on the server. Use a separate directory such as `/opt/mewmo`; do not put files in rental-mgmt's directory.
2. Copy `.env.example` to `.env`. Generate a unique URL-safe `DB_PASSWORD` with `openssl rand -hex 32`, and a password hash with `scripts/hash_password.py`. Keep the hash single-quoted so dollar signs are literal.
3. Set `CORS_ORIGINS=https://YOUR_MEWMO_HOST,capacitor://localhost` and keep `COOKIE_SECURE=true`.
4. Create `secrets/` and `backups/`. Protect `.env` and backups with owner-only permissions. APNs key files must be readable by the container's UID 10001; do not make them world-readable.
5. Validate and start:

```bash
docker compose -p mewmo config --quiet
docker compose -p mewmo up -d --build
docker compose -p mewmo ps
docker compose -p mewmo logs --tail=100 api worker backup
curl --fail http://127.0.0.1:8092/api/health
```

`migrate` must finish successfully before the API and worker start. PostgreSQL is not published to a host port. The only exposed endpoint is Mewmo's loopback HTTP port 8092.

### TLS and Sharing a Server

Use a dedicated Mewmo hostname behind the server's HTTPS edge. `deploy/nginx-edge.example.conf` is a HOST-level routing example to `127.0.0.1:8092`. It disables request spooling, so uploaded bills are not retained by the edge.

**Do not blindly bind port 80/443 or replace rental-mgmt's proxy configuration.** Its existing deployment may already own those ports. If there is no independent host-level edge, choose a separate IP/HTTPS port or plan an edge migration before deploying Mewmo. No such server changes are performed by this repository.

On the current host, rental-mgmt owns 80/443 and canddle owns 8443, so Mewmo runs its own edge at `https://mewmo.rental-mgmt.us:9443` (`deploy/compose.edge.yaml`, enabled with `COMPOSE_FILE=compose.yaml:deploy/compose.edge.yaml` in `.env`). Set `CORS_ORIGINS` and the iPhone app's `VITE_API_BASE_URL` with the `:9443` port included. The certificate comes from the host's certbot. rental-mgmt's nginx serves `/var/www/certbot` for any hostname on port 80, so validation needs no rental-mgmt changes:

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d mewmo.rental-mgmt.us \
  --deploy-hook "sh -c 'cd /home/ubuntu/mewmo && docker compose exec -T edge nginx -s reload'"
docker compose up -d edge
```

This needs a DNS A record for the hostname and inbound 9443 open in the AWS security group. Renewals also run the host's existing hook, which gracefully reloads rental-mgmt's nginx.

The Mewmo Compose stack does not join any rental-mgmt network or reuse its database, backup storage, credentials, ports, or Compose files. A shared TLS edge, when available, only routes traffic; it is not a shared application stack.

### Push Configuration

**APNs**

- Create an Apple Push Notifications authentication key in your Apple Developer account.
- Place the `.p8` file in `secrets/` and set `APNS_KEY_PATH=/run/secrets/AuthKey.p8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_TOPIC` (the app's exact bundle ID).
- `APNS_SANDBOX=true` is for development-signed builds; use `false` for TestFlight/distribution. This MVP uses one APNs environment per server.
- Restart the API and worker after changing configuration.
- In the iPhone app, open Notifications and choose **Enable on this device**.

**Web Push**

```bash
# Run with the backend virtual environment:
python scripts/generate_vapid.py
```

Put the generated VAPID keys in Mewmo's root `.env`, set `VAPID_SUBJECT`, and restart API/worker. Never commit the private key. Enable notifications in each browser. Safari on iPhone requires a Home Screen web app; the Capacitor app uses APNs instead.

Missing push credentials do not result in fake successful sends. Reminders show `failed` and retry until a service accepts them. Devices with revoked tokens are disabled.

## iPhone

The generated Xcode project is in `frontend/ios/App/App.xcodeproj`, using Swift Package Manager. It contains APNs registration callbacks and separate development/production entitlement settings. No `NSMicrophoneUsageDescription` is present.

```bash
# From frontend/. Use your actual HTTPS API origin:
VITE_API_BASE_URL=https://YOUR_MEWMO_HOST/api npm run ios:sync
npm run ios:open
```

Select your Apple Development Team, choose a unique bundle ID if necessary, and ensure that APNs is enabled for that ID and signing profile. Match `APNS_TOPIC` on the server. Run on a physical iPhone or archive for TestFlight.

The client is bundled locally, not loaded from a remote `server.url`. Native API access requires HTTPS and refuses a relative/plain-HTTP API URL. Native requests use bearer tokens and omit WebView cookies. Tokens remain in memory unless the user explicitly enables biometric sign-in as described below. Notification registration remains on the server independently of session expiry. Explicit sign-out or signing into another account disables the previous account's registrations on that installation; re-enable notifications after signing in. Other devices are unaffected. Use a device's **Disable** button to stop its deliveries remotely.

Camera/photo library descriptions support importing bill photos. Dictation remains entirely owned by the iOS keyboard. A file import never marks anything paid, even if the document contains instructions to do so.

### Face ID Sign-In

1. Rebuild and install the updated native iPhone app. Enable Face ID and a device passcode in iPhone Settings.
2. Sign in with your username and password, then open **Settings → Your account → Face ID sign-in → Enable Face ID**.
3. After a cold app launch, tap **Sign in with Face ID**. Password sign-in is always available. Touch ID is supported on devices that use it instead.

This is native iPhone sign-in, not browser face recognition or a passkey implementation. It does not automatically lock an already-open app when it goes into the background. Mewmo never reads face images or biometric templates, and never saves the account password. A single session per API address is saved in the app's Keychain, protected by `biometryCurrentSet` and `WhenPasscodeSetThisDeviceOnly`: it cannot sync to another device, requires biometrics to read, and is invalidated when biometric enrollment changes. Capacitor bridge logging is disabled to avoid logging session tokens.

The server still validates the session after every unlock. Sessions expire **seven days after password sign-in**, not seven days after enabling Face ID. Expiry/revocation requires password sign-in and enabling Face ID again. Signing out, switching accounts by password, or disabling the feature removes the saved session. Cancelling a scan or losing network connectivity does not bypass authentication; a network failure retains the protected session for retry.

Physical-device release checks:
- Enable, force-quit/relaunch, unlock successfully, and cancel a scan.
- Deny Face ID permission, test biometric lockout, and confirm password fallback.
- Disable the feature, sign out, and switch accounts; verify the prior saved account cannot return.
- Re-enroll Face ID and test an expired/revoked server session; both must require password sign-in.

## Reminder Semantics

| Type | Defaults |
| --- | --- |
| appointment | 1,440 and 60 minutes before |
| bill | 10,080 and 1,440 minutes before; 09:00 on due date; 09:00 the next day while open |
| dated_item | 10,080 and 1,440 minutes before; 09:00 on due date |

Absolute timestamps are stored in UTC; the item's IANA zone is retained. Calendar-day rules use that zone. Nonexistent/ambiguous appointment times at DST transitions are rejected for the owner to correct. Custom calendar-day rules use the first occurrence of a repeated time; a skipped wall time advances to the next valid instant.

`pending -> sent` occurs only after provider acceptance. Failed sends use 30/60/120/240/300-second backoff, scanned every 60 seconds. Normally an available, healthy worker starts delivery on its next scan, within two minutes of fire time for personal-use load. Provider/network outages and a stopped worker cannot meet that target; monitor the services.

Every reminder has its own APNs identifier or Web Push notification tag. There is no shared collapse ID. Payloads contain only a sanitized title, full date/time/zone, and identifiers, never amount/account fields. The OS can still group an app's notifications, but distinct reminders do not replace one another.

Payment, completion, editing, deletion, and sending serialize on the item row. Unsent reminders are cancelled on completion/delete; undo restores future ones only. An already accepted or in-flight push cannot be recalled. Time changes cancel old unsent rows and create/revive the new future schedule while preserving sent audit rows.

Device-level acceptance is recorded so an ordinary retry does not resend to already accepted devices. Delivery is **at least once**, not exactly once: a crash after external acceptance but before transaction commit can cause a retry. Provider acceptance also does not guarantee the phone displayed or the owner read the notification. These limitations are shown in the delivery UI.

## Privacy and Operations

- Imported bytes remain in a bounded request buffer and temporary OCR directory. Files and OCR intermediates are deleted on success/failure; production `/tmp` is tmpfs. Nginx request buffering is disabled.
- Documents are untrusted data. Local extraction uses fixed command arguments and narrowly labelled fields; it has no network/tool/action instructions from the document and no database writes.
- Full source text and filenames are not saved. Account-number-like sequences in titles/payees are redacted to their last four digits.
- Deleting an item cancels pending reminders and redacts its personal fields. Minimal tombstone/delivery audit rows remain. Historical database backups retain their earlier snapshots until expiration.
- Push subscriptions are sensitive credentials stored in the private database. Keep host disks/backups encrypted and restrict server access.
- The client stores a random installation identifier, not an account password or session token, to detach notifications on sign-out/account switching. Clearing browser storage may lose that identifier; disable the old device registration from Settings. Already accepted/in-flight notifications cannot be recalled, and displayed-notification cleanup is best effort.
- Account isolation is enforced by the API and worker, including administrator requests. Server/database operators and anyone with backup access can still access stored data; this is not end-to-end encryption.
- No offline item cache or automatic offline submission is provided; an unavailable server produces an error.

### Backups

The Mewmo-only backup service writes atomic, validated PostgreSQL custom-format dumps to `./backups/mewmo-TIMESTAMP.dump`. It runs at startup and every 24 hours by default; retention is 14 days. A failed backup does not prune older successful dumps.

Verify a dump without modifying a database:

```bash
docker compose -p mewmo exec -T backup pg_restore --list /backups/mewmo-TIMESTAMP.dump
```

Test a restore into a **new** isolated database:

```bash
docker compose -p mewmo exec -T db createdb -U mewmo mewmo_restore_check
docker compose -p mewmo exec -T db pg_restore -U mewmo --no-owner --no-acl \
  -d mewmo_restore_check < backups/mewmo-TIMESTAMP.dump
```

Inspect the restored data before planning any actual recovery. Never restore into rental-mgmt. Restoring an old backup can also restore old device tokens, sessions, and pending reminders; keep the Mewmo worker stopped while reviewing a recovery.

Local dumps do not survive losing the host. Configure an encrypted off-host copy in a **Mewmo-only** bucket/prefix with separate credentials and retention before relying on backups. Automatic off-host transfer is not configured without a destination.

## Tests

```bash
# backend/
.venv/bin/pytest -q
.venv/bin/ruff check app migrations tests

# Optional: real PostgreSQL migration and concurrent-worker tests.
# Uses disposable UUID-named schemas, not production tables.
TEST_POSTGRES_URL=postgresql+psycopg://USER:PASS@localhost:5432/DEDICATED_TEST_DB \
  .venv/bin/pytest -q

# frontend/
npm test
npm run build
npx playwright install chromium
# Keep `python backend/tests/run_e2e.py` running in a separate terminal.
npm run test:e2e
```

The browser suite exercises the real API on desktop and iPhone-sized Chromium. This is responsive-layout testing, not a substitute for physical iPhone tests.

Account tests cover cross-user reads/mutations, private duplicate checks, notification ownership and reassignment, password/session revocation, invite expiry/revocation/reuse, legacy-data migration, and concurrent invite redemption against PostgreSQL.

Required regression: with local date `2026-11-06`, `后天9点有医生预约` creates only an appointment draft titled `医生预约`, for **Sunday 2026-11-08 at 09:00**. The confirmation UI displays that full date and time.

Before production use, verify physical-device APNs and browser push acceptance, original-file cleanup in the deployed container, a backup restore, and delivery latency with a real reminder. Docker and Apple signing/push credentials are required for those deployment checks.

### Verification in This Workspace

The multi-user update passed 91 backend tests (including the isolated PostgreSQL concurrency suite), 9 client unit tests, and 14 desktop/iPhone-sized browser tests. The final client build, Capacitor sync, backend lint, and patch checks passed. Three real-OCR tests remain skipped. This update has not been deployed to production.

On 2026-11-06: 71 backend tests, 6 client unit tests, and 8 browser tests passed. Real PostgreSQL migration/concurrency tests used an isolated PostgreSQL 18.6 test cluster; the production Compose target remains PostgreSQL 16. The Vite production build, Capacitor sync, Swift syntax checks, plist validation, and Compose YAML/isolation checks passed. The production client dependency audit reported no known vulnerabilities.

Three real-OCR tests were skipped because Tesseract/Poppler installation was blocked by the macOS sandbox. HEIC decoding, parser behavior, import failure, and temporary cleanup were tested independently. The same sandbox restriction prevented Xcode/SwiftPM from reaching native compilation. Docker was unavailable, so production Compose execution, a real backup restore, and actual APNs/Web Push delivery were not verified. No production deployment or changes to rental-mgmt were made.
