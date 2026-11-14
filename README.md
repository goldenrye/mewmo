# Mewmo

An invite-only, multi-user bill, reminder, and notes app. Each person has a private account. Capture an item, review the draft, confirm it, get reminded, and stop reminders when it is handled. Keep undated notes alongside reminders and find them later by typing or speaking.

## Stack

- FastAPI, SQLAlchemy 2, PostgreSQL 16, Alembic.
- React, TypeScript, Vite. The same UI runs on the web and in Capacitor 8 on iPhone.
- APNs for iPhone and Web Push for browsers.
- Local Poppler, Tesseract (English and simplified Chinese), and Pillow/HEIF decoding. Enabled per-user AI interprets text first; deterministic parsing is the fallback.
- A dedicated Docker Compose project, PostgreSQL container/volume, networks, credentials, and backup directory. Nothing mounts or connects to rental-mgmt.

## Implemented

- PDF and image import for bills, appointments/events, and dated reminder notices, including scanned PDFs and HEIC photos. Limits: 12 MB, 5 PDF pages, 25 megapixels.
- In-memory drafts with uncertain fields, manual fallback, possible duplicate warnings, and account-number redaction.
- Chinese/English/mixed text capture, plus an opt-in microphone using iPhone or browser system speech recognition. Keyboard dictation remains available.
- Undated notes with text/audio capture and PDF/image import, explicit save confirmation, editing/deletion, and contextual text/audio search.
- English and Simplified Chinese interfaces, with automatic device-language detection and a saved language selector.
- Optional per-user OpenAI, Claude, Gemini, or Doubao model settings, encrypted API keys, connection testing, and per-import image consent.
- Full date, weekday, time, and IANA zone on every reminder confirmation card; notes have no due date or notifications.
- Manual create/edit/delete, overdue-first home, search, calendar, one-tap paid/completed, undo, and history.
- Editable reminder rules; each fire time has a database row and per-device delivery audit.
- A 60-second worker scan with retry, cancellation, rescheduling, and future-only restoration on undo.
- Username/password accounts, hashed/revocable sessions, origin checks, and login rate limits.
- Administrator-created, single-use invitation links that expire after seven days, with revocation and status tracking.
- Per-user items, history, duplicate detection, reminder audit, and notification devices. Administrators cannot read other users' items through the app.

Capture is AI-first when a user has enabled a model: the first usable model response supplies the draft, including its title, item type, amount, and date. Without AI, or after all models fail, conservative local parsing handles common relative dates, explicit clocks, weekdays, and labelled invoice fields. Missing information requires review. AI is not an autonomous agent: it cannot save items, send reminders, or execute instructions inside documents.

**Parsing never creates items or reminders.** Only a separate item request with `confirmed: true` writes an item. Drafts are neither stored in the database nor cached in browser storage.

The compact Overview places **Reminders / Notes** beside the page title. Manual **Add item** is beside **Add a reminder** (a `+` button on small phones); item and overdue counts sit with the list. Import areas show one **PDF or image / Import options** row. Expand it for limits, privacy guidance, and optional **Share images with AI** consent. A collapsed **AI images on** label keeps active image sharing visible. Text sizes and 44-pixel tap targets are preserved.

### Notes and Voice Search

Home has a **Reminders / Notes** switch; the existing Calendar, History, Alerts, and Settings navigation stays unchanged. Notes never appear as overdue, in the calendar, or in reminder delivery/history.

1. Choose **Notes > Write a note**. Type details such as `Living room floor: 12500 mm by 6400 mm`, choose **Voice input**, or choose **Import note** for a PDF/image. System speech fills the same editable text box; file import opens an unsaved review draft.
2. Choose **Preview note**, review the suggested title and full text, then **Confirm & save**. Notes require no date/time. They retain your text and numbers without AI rewriting. Limits: 180-character title and 10,000-character body.
3. Choose **Find notes**. Type or dictate a phrase such as `the notes about the floor` or `找一下关于地板的笔记`, then explicitly search. Open a matching card to read the complete saved note. Search does not create or change anything.
4. Open a note to edit/delete it or choose **Add reminder**. This prepares a separate reminder with the note's title and requires you to choose a date/time and confirm. The original note stays unchanged. The two records are independent: edits/deletions do not synchronize between them.

Local search uses normalized English keywords, Chinese bigrams, and a small set of bilingual topic synonyms. It ranks matches and pages results in groups of 50; it is not a universal semantic search engine. **Settings > AI assistance > Configure model > Use AI for note search** controls automatic query expansion for both typed and spoken searches; there is no per-search checkbox. New model setup selects this and **Use AI by default**, but neither takes effect until the settings are saved. Existing saved opt-outs remain unchanged. Only the search phrase is sent to the user's provider, with best-effort account-number redaction; stored note bodies/titles/IDs are never sent. Results always come from the current user's saved notes, not generated answers. Invalid output, rate limits, or provider failures show a notice and fall back to local matching. AI-expanded searches, including pagination/refreshes, can incur provider charges.

Audio uses the same English/Mandarin system speech service as reminders. Review the recognized text and tap Search or Preview; audio never silently saves or searches. Switching capture modes or leaving the page stops active recognition, discards unfinished speech, and ignores late callbacks. Typed unsaved notes are in memory only and are discarded when leaving Notes; there is no offline cache or auto-save. The feature displays matching notes, not spoken answers.

**Import note** accepts the same PDFs and images as reminder import, including scanned PDFs and HEIC photos. You can also drop one file onto the write-note card. Limits remain 12 MB, five PDF pages, and 25 megapixels; note and reminder imports share the two-import processing limit. Any readable content can become a note; dates, bill fields, and reminder intent are not required. Local OCR retains text, line breaks, dates, and measurements. Recognizable account/card numbers are reduced to their last four digits before text is returned or sent to AI; this is best effort, so review sensitive details. Imports over 10,000 characters retain only the first part with a visible warning. Exact-body duplicate warnings only consider your own notes.

With AI enabled, extracted note text is sent to your ordered models for a **title suggestion only**; the local body is not summarized or rewritten. The same optional, per-import image consent used for reminders allows AI to transcribe a note from the document images, including when local OCR fails. Image transcription can miss or misread details: review the full text and extraction notices. The consent checkbox lists the model chain and resets after each attempt or leaving the mode; the server rejects stale chain consent. Provider/schema failures try the next model, then retain local text with a warning; unreadable files offer **Enter manually**. Typed/audio note capture is unchanged and does not use AI. Stored notes are never included in import prompts.

The source file and OCR intermediates are discarded. Only explicitly confirmed title/body text is saved through the existing note API; imports never create reminders, execute embedded instructions, or store attachments. Cancelling review leaves existing notes unchanged and preserves any typed capture text. Leaving Notes ignores late import responses. This feature adds `POST /api/notes/drafts/file` without a database migration; deploy the updated backend and web client, and rebuild/sync the iPhone client.

Notes are stored in a separate user-owned `notes` table, without due-date/status/rule fields or reminder rows. All reads, searches, updates, and deletes are account-scoped, including administrator requests. Version checks reject stale edits/deletes from another device. Note text is stored as entered, including long measurements or sensitive details, so only put information here that you intend to retain. Note deletion removes the active record and search text, but existing database backups retain prior snapshots. Notes are not end-to-end encrypted.

Deploy through migration **0006** (`alembic upgrade head` / the existing Compose migrate service) before starting the updated API, then deploy the web client and rebuild/sync/reinstall the iPhone client. Migration 0004 adds notes; 0005 adds the saved note-search preference, defaulting existing accounts to local search; 0006 adds ordered model fallbacks. Existing items, reminder rules, and delivery history are unchanged. Older settings clients that omit the note-search field preserve its saved value and cannot silently grant consent. Older search clients may still opt out with `use_ai=false`, but `true` cannot override a disabled saved preference. No new microphone plugin or embedding service is needed.

### Reminder Import

On Home, choose **Import reminder** to upload a PDF or image containing a bill, appointment/event confirmation, or dated notice such as a renewal, expiry, or return deadline. The importer prepares one draft with the matching item type and default reminder rules. It never creates multiple items automatically.

Local extraction supports English and Chinese labels, event dates/times, and relative dates using the client's local date and IANA timezone. Common sent/printed/birth-date metadata lines are excluded. Missing or conflicting dates/times require review; appointment times are not invented. Dated notices without a time suggest 09:00 and flag it for confirmation. Event prices do not populate bill fields. Titles and inferred item types are flagged for review.

Unrecognized files offer manual entry. Imported items always start open, even when a document says paid/completed or contains instructions. Files are discarded after parsing, and nothing is saved until **Confirm & save**. Optional AI assistance supports all three types, with the same review boundary. Updating the backend enables extraction; rebuild the web/iPhone clients for the new labels and consent descriptions.

### Local Bill Extraction

Without enabled AI, bill import uses local OCR and deterministic field matching, with no LLM or external document service. The same field parser is the fallback after all AI models fail. It supports paired column headings such as `Due date / Amount due`, values on nearby lines, and repeated matching totals. Conflicting totals or dates stay blank; a candidate with an unreadable repeated label remains flagged for review.

Payees can come from explicit English/Chinese labels, short company-like headers, or phrases such as `valued Boost Mobile customer`. Inferred payees and titles always show **Check this**. Dollar symbols alone still require currency confirmation. Local bill dates require an explicit year and unambiguous ordering: `NOV 12, 2026` works, while `11/12/2026` requires manual confirmation. Natural-language relative-date parsing is unchanged.

Matching stops at unrelated fields such as bill periods, previous balances, autopay, and card expiry. Scheduled autopay never marks a bill paid. Only the account's last four digits are returned; original files and OCR intermediates remain temporary. This is not a general document-understanding engine: blurry text, unfamiliar layouts, and logos without readable issuer text may still need manual entry.

Regression coverage includes a synthetic Boost-style OCR transcript yielding **Boost Mobile / 61.78 / November 12, 2026**, with the inferred payee and currency flagged. Generated two-column PNG/PDF/HEIF tests require Tesseract and Poppler; transcript tests do not prove extraction from a particular original image. This is a backend change: deploying the updated API enables it for both browser and iPhone imports without rebuilding the iPhone app.

## Optional AI Assistance

Open **Settings > AI assistance > Configure model**. Each user can save up to **five ordered models**, each with its own provider, model ID, and API key. The provider menu lists **OpenAI (GPT)**, **Claude (Anthropic)**, **Gemini (Google)**, and **Doubao (Volcengine Ark)**. Multiple models from the same provider are supported. Supported APIs are OpenAI Chat Completions with JSON output, Anthropic Messages, Google Gemini `generateContent`, and Volcengine Ark Chat Completions. Use a model available to your provider account; custom URLs and local model servers are not supported. Keys are encrypted on the Mewmo server, never returned by the API, and never stored in browser storage. Leaving a saved model's key blank preserves it through edits and reordering; changing its provider requires a new key and fresh consent in the UI.

Use **Add model**, **Move up**, and **Move down**, then **Save AI settings**. The first model is labeled **Default**; every new AI capture/search starts there. On a provider failure, timeout, unusable credential, or invalid response, Mewmo tries the next entry in order and stops at the first usable response. Each response is validated independently; partial results are never mixed across models. This applies to reminder text/audio interpretation, file extraction, and enabled AI note search. If all models fail, local parsing/search and manual-entry fallbacks remain available. A successful backup attempt shows a notice. An empty but valid note-search expansion does not trigger more provider requests, and failed models are not permanently reordered.

Removing an entry from the list takes effect only after saving. **Test saved model** on an entry tests that exact model, without fallback masking a failure. Stale edits/deletes are rejected so one device cannot overwrite newer settings; **Reload saved settings** discards unsaved edits and reloads the current list. Older single-model clients can continue capturing, but cannot edit/delete a multi-model configuration; update the app to manage it.

For **Doubao**, use a public Volcengine Ark API key and a Beijing-region Model ID or Endpoint ID (`ep-...`). Requests go only to `https://ark.cn-beijing.volces.com/api/v3/chat/completions`, using JSON output and disabled thinking for bounded extraction. Select a model supporting these options, and vision input if needed. This is not the Doubao consumer app or an internal ByteDance model endpoint. See the [official Ark Chat API reference](https://www.volcengine.com/docs/82379/1494384).

If the menu appears fixed on OpenAI, check whether server encryption is configured and whether the installed client is current. The provider selector remains browsable before encryption setup, while entering keys, enabling AI, saving, and testing remain disabled. Claude was previously labeled only "Anthropic". The current ordered-model settings require migration `0006` plus updated backend and web/iPhone clients.

**Use AI by default** is preselected for new model setup. Saving credentials and this setting enables AI-first capture; opening Settings alone never enables it. Accounts without a model remain local-only, and existing disabled configurations stay disabled. API clients that omit `enabled` still default to off. Enabling AI permits new reminder input or extracted OCR text to be sent to configured providers in order until one succeeds. No additional AI checkbox is needed for text, audio transcripts, or extracted file text. Each attempt may incur provider charges, including failed attempts. Typed/audio note capture does not use AI; note imports use title suggestions and optional image transcription as described above. Note-search expansion follows its saved permission and the master toggle, checked by the server on every search. Only the search phrase is sent, never stored notes. Recognizable account numbers are redacted, but names, addresses, amounts, or other personal details may remain. Model input is limited to the first 12,000 characters (10,000 for note imports). There is no background reprocessing of saved items, automatic payment, or AI access to reminder dispatch or other accounts.

**Allow optional image analysis** makes a separate checkbox available on the capture card. With multiple models, the checkbox lists the ordered providers/models that may receive images. Check it for each import; it resets after the attempt or leaving the page. A server-checked consent token binds approval to the exact chain, including order and credential changes. A stale token is rejected before any provider call. Legacy single-model image requests remain supported only for single-model configurations; multi-model imports require the updated client and chain consent. Images can contain full account details and other sensitive information and are not text-redacted. Mewmo strips metadata and converts images or up to five PDF pages to bounded PNGs (2,000-pixel maximum dimension, 8 MB total base64 payload); PDF conversion requires Poppler. Provider retention policies still apply even though Mewmo discards originals and intermediate files.

AI creates the draft directly rather than filling gaps in a local draft. The local semantic parser does not run on AI success. AI fields are flagged for review, missing fields stay blank (no automatic 09:00 in an AI draft), and the editor shows whether the draft came from AI or local parsing. A small deterministic safety layer preserves a single explicitly written clock and calculates supported minute/hour countdowns, including their at-time reminder rule. Multiple clock mentions are left to AI interpretation. Invalid timestamps, contradictory classification, empty titles, malformed JSON, and forbidden fields trigger the next model. Missing optional fields can still produce a reviewable draft. Default reminder rules and text payment status remain application-controlled; file imports always start open. Only locally extracted account-number last four digits are retained. Nothing is saved until confirmation.

This AI-first update needs no database migration or new environment variables. Existing enabled accounts automatically use the new interpretation path after backend deployment; update the web/iPhone clients for new setup defaults and provenance labels. Existing keys, model order, opt-outs, image consent, notes, and saved reminders are preserved. AI quality depends on the configured model; schema validation and review do not guarantee factual accuracy.

**Test saved model** sends only a synthetic request, can incur provider charges, and checks text/JSON connectivity, not vision support. Image analysis requires a vision-capable model. Use **Remove all models** (or **Remove model** for one entry) to delete encrypted credentials and revert to local-only capture. Disabling AI stops future workflows; it cannot recall an in-flight workflow or delete provider copies. The app limits assistance to 30 workflows and connection tests to 5 requests per user per five minutes. Each workflow tries at most five models sequentially; provider errors do not bypass the app's own rate limit. There are four simultaneous provider calls per API process, bounded responses, and network read timeouts of 15 seconds per attempt for a multi-model chain or 30 seconds for a single model. Fallback can increase latency and cost.

### Server Setup

Before users can save keys, generate a Fernet encryption key using the backend environment:

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Set `LLM_ENCRYPTION_KEY` in the server's private `.env` (or `backend/.env` for local development). Never commit it. Keep it stable across restarts and store a backup separately from the database backups. Database backups contain encrypted provider credentials; restoring them without the same encryption key makes them unusable. There is no automatic key rotation: users must re-enter provider keys after changing or losing this key. Missing or invalid encryption configuration disables saving and provider calls, while local parsing and credential removal remain available.

Deploy the backend and web client using the existing upgrade procedure, including `alembic upgrade head` / the Compose `migrate` service. Migration `0006` preserves the existing primary model, encrypted key, and consent settings, adds an initially empty fallback table, and versions configuration changes. Rebuild/sync/reinstall the iPhone client for the new settings and consent controls. Do not place provider keys or `LLM_ENCRYPTION_KEY` in any `VITE_*` variable.

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

For an entirely disposable browser preview, `backend/tests/run_e2e.py` starts a SQLite-backed API on port 8000 with username `admin` and the **test-only** password `mewmo-local-test`. It creates a temporary AI encryption key for settings tests and removes its temporary database when stopped. This is not a production mode and does not run a reminder worker.

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

The generated Xcode project is in `frontend/ios/App/App.xcodeproj`, using Swift Package Manager. It contains APNs registration callbacks and separate development/production entitlement settings. Microphone and speech recognition permission descriptions are included in English and Simplified Chinese.

```bash
# From frontend/. Use your actual HTTPS API origin:
VITE_API_BASE_URL=https://YOUR_MEWMO_HOST/api npm run ios:sync
npm run ios:open
```

Select your Apple Development Team, choose a unique bundle ID if necessary, and ensure that APNs is enabled for that ID and signing profile. Match `APNS_TOPIC` on the server. Run on a physical iPhone or archive for TestFlight.

The client is bundled locally, not loaded from a remote `server.url`. Native API access requires HTTPS and refuses a relative/plain-HTTP API URL. Native requests use bearer tokens and omit WebView cookies. Tokens remain in memory unless the user explicitly enables biometric sign-in as described below. Notification registration remains on the server independently of session expiry. Explicit sign-out or signing into another account disables the previous account's registrations on that installation; re-enable notifications after signing in. Other devices are unaffected. Use a device's **Disable** button to stop its deliveries remotely.

Camera/photo library descriptions support importing bill and reminder photos. A file import never marks anything paid or completed, even if the document contains instructions to do so.

### Microphone Input

On Home, choose **Voice input** beside **Import reminder**. This clears the reminder box. Select English or Mandarin, read the privacy notice, then **Hold to speak**: press and hold, speak, and release to finish. Slide upward at least 64 pixels until **Release to cancel** appears, then release to discard; sliding back restores normal release-to-finish. There are no separate Start/Stop listening buttons. Speech appears directly in the main reminder box; there is no separate transcript panel. Recognition also stops after 60 seconds. Notes and note search use the same control. Releasing only leaves editable text; **Preview draft** and **Confirm & save** are still required.

Keyboard users can hold Space or Enter on the speech control and release to finish; Escape cancels. Screen-reader activation uses the same button once to begin and again to finish, without requiring a hold gesture. Losing focus, a cancelled touch, leaving the page, or releasing before microphone startup cancels unfinished speech and ignores late callbacks. On first use, grant any system permissions, then hold again if the permission prompt interrupted the gesture.

When AI assistance is enabled, previewing sends the text through the existing per-user model interpretation path. Recording does not call the LLM, upload audio to Mewmo, or save an item. Mewmo does not record audio files or persist transcripts automatically. Apple or the browser's speech provider may process audio online under their policies; this is not an offline-only feature. Recognition accuracy for mixed-language speech varies; select the main spoken language and correct the text before previewing.

Draft review keeps uncertain fields, duplicate warnings, and extraction failures visible. Routine AI/OCR notes are grouped under **Extraction details**; optional time zone/account fields and reminder rules remain expandable. Date/time inputs stack on narrow screens, and reminder controls use separate rows to avoid overlap.

iPhone uses a registered native `SFSpeechRecognizer`/`AVAudioEngine` bridge, requests microphone and speech permission only after activating the speech control, and stops on cancellation, backgrounding, interruptions, or leaving Home. Rebuild/install the app for the updated controls; no new permissions or backend migration are needed. Browser input uses `SpeechRecognition`/`webkitSpeechRecognition` over HTTPS (or localhost); availability depends on the browser, language, network, and device. Unsupported clients and permission failures keep typing and keyboard dictation available. No separate transcription API key is needed.

Automated speech tests use simulated recognition events. Real iPhone permissions, audio routing, system speech services, and real-browser microphone recognition still require device testing.

### Face ID Sign-In

1. Rebuild and install the updated native iPhone app. Enable Face ID and a device passcode in iPhone Settings.
2. Sign in with your username and password, then open **Settings → Your account → Face ID sign-in → Enable Face ID**.
3. After a cold app launch, tap **Sign in with Face ID**. Password sign-in is always available. Touch ID is supported on devices that use it instead.

This is native iPhone sign-in, not browser face recognition or a passkey implementation. It does not automatically lock an already-open app when it goes into the background. Mewmo never reads face images or biometric templates, and never saves the account password. A single session per API address is saved in the app's Keychain, protected by `biometryCurrentSet` and `WhenPasscodeSetThisDeviceOnly`: it cannot sync to another device, requires biometrics to read, and is invalidated when biometric enrollment changes. Capacitor bridge logging is disabled to avoid logging session tokens.

The server still validates the session after every unlock. Sessions expire **seven days after password sign-in**, not seven days after enabling Face ID. Expiry/revocation requires password sign-in and enabling Face ID again. Signing out, switching accounts by password, or disabling the feature removes the saved session. Cancelling a scan or losing network connectivity does not bypass authentication; a network failure retains the protected session for retry.

After a timeout, connection/server failure, or cancelled scan, **Retry Face ID** (or **Retry Touch ID**) stays available. Retries are manual, with a fresh biometric unlock and server check each time; there is no automatic retry or switch to password login. The user can instead choose the password form at any time when no attempt is running. A native status refresh does not remove the retry option after a transient failure. Password sign-in is required only when the saved credentials are missing/invalid or the server rejects the saved session.

Login shows separate **Unlocking your saved sign-in...** and **Checking your session with the server...** stages. After the Keychain unlock completes, server verification (including reading the response body) is limited to ten seconds. A timeout aborts the request, clears the unverified in-memory session, and restores retry/password controls without deleting the protected Keychain session. Late responses cannot sign in or sign out a newer account. The limit does not interrupt the system Face ID prompt, and a delayed native availability refresh does not block password fallback. This bounds network-related waiting; it does not establish or fix the cause of a slow iPhone network or Keychain operation.

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

For a typed or dictated countdown such as **增加一个5分钟后的测试提示**, **in 5 minutes**, or **5 minutes later**, Mewmo calculates the target from the client's current timestamp and adds a single reminder **at that time** (`before:0`). This avoids both the 09:00 draft fallback and past default reminders being skipped. Minute/hour offsets cross midnight correctly and use elapsed UTC time through daylight-saving changes; an ambiguous resulting local time must be corrected manually. Because the editor stores whole minutes, results are rounded **up** to the next minute, with a visible note, so they are not sent early. AI cannot replace this locally calculated date/time or remove the at-time rule. Invalid or conflicting supported durations require manual correction. Normal non-countdown defaults remain unchanged.

Updated clients send `client_now` alongside the local date and IANA time zone. Older clients without a timestamp use the server's current instant for countdown parsing, so deploying the backend also fixes their basic countdown behavior; keep the server clock synchronized. Nothing is scheduled until confirmation, and a countdown left unconfirmed until its target is past is skipped under the existing policy. This change requires no new database migration. Rebuild/sync the web/iPhone clients to use the device clock and see localized rounding messages.

Absolute timestamps are stored in UTC; the item's IANA zone is retained. Calendar-day rules use that zone. Nonexistent/ambiguous appointment times at DST transitions are rejected for the owner to correct. Custom calendar-day rules use the first occurrence of a repeated time; a skipped wall time advances to the next valid instant.

`pending -> sent` occurs only after provider acceptance. Failed sends use 30/60/120/240/300-second backoff, scanned every 60 seconds. Normally an available, healthy worker starts delivery on its next scan, within two minutes of fire time for personal-use load. Provider/network outages and a stopped worker cannot meet that target; monitor the services.

Every reminder has its own APNs identifier or Web Push notification tag. There is no shared collapse ID. Payloads contain only a sanitized title, full date/time/zone, and identifiers, never amount/account fields. The OS can still group an app's notifications, but distinct reminders do not replace one another.

Payment, completion, editing, deletion, and sending serialize on the item row. Unsent reminders are cancelled on completion/delete; undo restores future ones only. An already accepted or in-flight push cannot be recalled. Time changes cancel old unsent rows and create/revive the new future schedule while preserving sent audit rows.

Device-level acceptance is recorded so an ordinary retry does not resend to already accepted devices. Delivery is **at least once**, not exactly once: a crash after external acceptance but before transaction commit can cause a retry. Provider acceptance also does not guarantee the phone displayed or the owner read the notification. These limitations are shown in the delivery UI.

### Urgent iPhone Alarms

In a reminder's review/edit form, enable **Urgent alarm**, then confirm the item. It is **off by default**, including AI/file/audio drafts; neither parsing nor AI can turn it on. On **iOS 26+**, the updated native app uses Apple's AlarmKit to schedule one local alarm at the confirmed due time. Alarm access requires separate system permission. If permission is denied while enabling urgency, the draft stays unsaved: allow access in iPhone Settings or turn off Urgent alarm.

AlarmKit alarms sound through Silent mode and Focus, but **iOS controls their volume**; Mewmo cannot force maximum volume. This is a fixed-date alarm, not a continuously displayed countdown. Countdown input still rounds up to the next whole minute as described above. Do not use Mewmo as your only protection for gas, fire, medication, or other safety-critical situations.

Urgent alarms use a bundled traditional twin-bell-style ringing sound, not the system's default alert tone. The original audio is generated reproducibly by `python3 scripts/generate_alarm_sound.py` as an eight-second, mono 16-bit PCM WAV and included in the native app's Copy Bundle Resources phase. Rebuild/reinstall the iPhone app and open Mewmo to sync: existing future scheduled alarms adopt the new sound, while dismissed or already-ringing alarms are left alone. This sound-only change needs no server migration and does not change ordinary push sounds. Verify playback on a physical iPhone.

After saving, check the item's **Urgent alarm** status for **Alarm scheduled on this iPhone**. Native scheduling happens only after the server saves the item. A failed alarm schedule does not undo that save or require creating another item; **Schedule alarm** retries using the latest saved item. Native status is separate from push delivery and does not prove the alarm was heard. Dismissing an alarm does not complete the reminder; an unchanged dismissed alarm is not recreated by routine refresh. Explicit scheduling can restore a removed future alarm.

**Notifications > Urgent alarms** enables or disables alarms on this iPhone. Disabling cancels local alarms without clearing items' urgent flags. Completion, deletion, turning urgency off, or changing a due time updates local alarms after a successful sync; undo only restores future alarms. Sign-out and account switching cancel local alarms. A cleanup error is shown explicitly because old alarms may still ring; retry after resolving the error. Native storage keeps the account/server binding, IDs, due times, and fingerprints; the OS-managed alarm contains the same amount-redacted title used for push.

Web and older-iPhone clients use **ordinary notifications only**. A web-created urgent reminder becomes a local iPhone alarm only after that phone signs in and syncs with alarm access enabled. Each enabled iPhone schedules independently. Changes made elsewhere, including completion or deletion, cannot instantly recall an offline phone's alarm: open Mewmo on that phone and sync. Once scheduled, the local alarm does not depend on the server worker or APNs connection.

Existing push rules remain active. Urgent items also receive an ordinary at-due-time push fallback when no configured rule already fires then; this does not alter the saved rule list. Alarm and push can both alert. The fallback cannot bypass Silent mode and follows normal worker/retry timing. No Critical Alerts entitlement, new APNs key, or APNs configuration change is required.

**Deployment:** back up Mewmo, stop the old API/worker, and run migration **0007** through `alembic upgrade head` or the existing Compose migrate service before starting the updated backend. Existing items default to non-urgent; older clients omitting the field preserve a previously saved preference. Deploy the web client, then build/sync/reinstall the native app with an AlarmKit-capable Xcode SDK. Updating the website alone cannot install the plugin or its English/Chinese `NSAlarmKitUsageDescription`. Older supported iOS versions remain installable but cannot use AlarmKit.

Before relying on a release, test on a physical iOS 26+ iPhone:

- Grant and deny alarm permission; verify default-off drafts and cancellation without saving.
- Schedule a harmless near-future reminder, verify scheduled status, lock the phone, and test with Silent mode and Focus enabled, including with Mewmo backgrounded or terminated.
- Check actual volume and stop behavior; verify stopping leaves the item open and routine sync does not recreate a dismissed alarm.
- Edit, complete, undo, delete, disable device alarms, sign out, and switch accounts; verify old alarms are cancelled and future replacements are correct.
- Change an item from the web while the phone is offline, then reopen/sync; verify the documented stale-alarm limitation and subsequent cancellation.
- Test revoked permission, native scheduling failure/limits, older iOS, and ordinary push fallback independently.

Automated browser tests mock the native bridge and cannot validate system sound, permission sheets, or locked-screen AlarmKit behavior.

## Privacy and Operations

- Imported bytes remain in a bounded request buffer and temporary OCR directory. Files and OCR intermediates are deleted on success/failure; production `/tmp` is tmpfs. Nginx request buffering is disabled.
- Documents are untrusted data. Local extraction uses fixed command arguments and narrowly labelled fields; it has no network/tool/action instructions from the document and no database writes.
- Full source text and filenames are not saved. Account-number-like sequences in titles/payees are redacted to their last four digits.
- Deleting an item cancels pending reminders and redacts its personal fields. Minimal tombstone/delivery audit rows remain. Historical database backups retain their earlier snapshots until expiration.
- Push subscriptions are sensitive credentials stored in the private database. Keep host disks/backups encrypted and restrict server access.
- The client stores a random installation identifier, not an account password or session token, to detach notifications on sign-out/account switching. Clearing browser storage may lose that identifier; disable the old device registration from Settings. Already accepted/in-flight notifications cannot be recalled, and displayed-notification cleanup is best effort.
- Account isolation is enforced by the API and worker, including administrator requests. Server/database operators and anyone with backup access can still access stored data; this is not end-to-end encryption.
- No offline item cache or automatic offline submission is provided; an unavailable server produces an error.
- Typed/audio notes retain their full text intentionally. Imported notes preserve measurements but redact recognizable account/card numbers before review. No saved notes are sent to import or search models.

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

The AI-first capture and countdown updates passed 385 backend tests, 44 client unit tests, and 128 desktop/iPhone-sized browser tests; 11 OCR/PostgreSQL checks were skipped. Coverage includes AI-selected fields and item types without local semantic parsing, ordered failures before local fallback, missing/invalid model output, saved opt-outs, new-setup defaults, draft provenance, explicit clocks, countdown confirmation/dispatch, and image consent. Production web builds, Capacitor asset sync, lint, formatting, and whitespace checks passed. Provider responses are mocked; live model quality, physical-iPhone delivery, and production deployment were not verified.

The ordered-model update passed 328 backend tests, 44 client unit tests, and 116 desktop/iPhone-sized browser tests; 11 OCR/PostgreSQL checks were skipped. Tests cover migration 0006, key-preserving reordering, model/account isolation, all-failed local fallback, default-first behavior, per-model connection tests, stale edits/deletes, and image-chain consent. Web builds, Capacitor asset sync, lint, and whitespace checks passed. Provider responses are mocked; production deployment, live-provider validation, and physical-iPhone testing were not performed.

The settings-based note-search update passed 308 backend tests, 44 client unit tests, and 110 desktop/iPhone-sized browser tests; 11 OCR/PostgreSQL integration tests were skipped. Coverage includes migration 0005, preserving existing consent, new-setup defaults, preference persistence/account isolation, legacy-client behavior, automatic search, and per-import image consent. Web builds, Capacitor asset sync, lint, formatting, and whitespace checks passed. Live-provider/physical-device testing and production deployment were not performed.

The notes update passed 291 backend tests, 44 client unit tests, and 108 desktop/iPhone-sized browser tests. Eleven OCR/PostgreSQL integration tests were skipped. Note CRUD, confirmation, account isolation, search, model-query privacy/fallback, optimistic version conflicts, audio cancellation, reminder creation, and narrow layouts are covered. Web builds, Capacitor asset sync, native permission plist validation, lint, and whitespace checks passed. Speech and provider tests use simulated recognition/mocked model responses; real-device audio, live-provider searches, and production deployment were not performed.

The multi-user update passed 91 backend tests (including the isolated PostgreSQL concurrency suite), 9 client unit tests, and 14 desktop/iPhone-sized browser tests. The final client build, Capacitor sync, backend lint, and patch checks passed. Three real-OCR tests remain skipped. This update has not been deployed to production.

On 2026-11-06: 71 backend tests, 6 client unit tests, and 8 browser tests passed. Real PostgreSQL migration/concurrency tests used an isolated PostgreSQL 18.6 test cluster; the production Compose target remains PostgreSQL 16. The Vite production build, Capacitor sync, Swift syntax checks, plist validation, and Compose YAML/isolation checks passed. The production client dependency audit reported no known vulnerabilities.

Three real-OCR tests were skipped because Tesseract/Poppler installation was blocked by the macOS sandbox. HEIC decoding, parser behavior, import failure, and temporary cleanup were tested independently. The same sandbox restriction prevented Xcode/SwiftPM from reaching native compilation. Docker was unavailable, so production Compose execution, a real backup restore, and actual APNs/Web Push delivery were not verified. No production deployment or changes to rental-mgmt were made.
