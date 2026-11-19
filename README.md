# TAAKRA 2027 student registration

A public, account-free registration portal with a React frontend, an Express API, PostgreSQL, and a background worker for Google Drive and Sheets. The public site validates applications and collects documents for organizer review.

## Run locally

Use Node.js 22.12 or newer and PostgreSQL 17. Docker Compose can provide a local database.

```sh
npm ci
cp .env.example .env
openssl rand -hex 32
docker compose up -d --wait db
```

Set `APP_SECRET` in `.env` to the generated value and set `RETENTION_DAYS` to your intended retention period. The example department and semester are for development. Replace them with the organizer’s choices for launch. Set `CATEGORIES_JSON` to the official choices, or use `[]` when categories are intentionally unavailable. Category stays optional in either case.

```sh
npm run db:migrate
npm run dev
```

Open `http://localhost:5173`. To test the production bundle locally, run `npm run build` and `npm start`, then open `http://localhost:3000`. Local operation may omit Google and Turnstile. Submissions still save to PostgreSQL and show **Received — processing** until a configured Google worker completes them. Use synthetic forms and images during development.

The included [illustration](public/taakra-art.webp) was generated from the written brief. Replace it with the official artwork at that path before launch. If its aspect ratio differs, update the image dimensions and alt text in [App.tsx](src/App.tsx). The browser renders the image at its native aspect ratio.

## Google setup

Enable the **Drive API** and **Sheets API** in an organizer-controlled Google Cloud project. Use a dedicated organizer account where possible. Choose one authentication path.

### Organizer’s personal Google account

1. Configure the project’s OAuth consent screen and a **Web application** OAuth client. Add the exact authorized redirect URI `http://127.0.0.1:53682/oauth/callback`.
2. On a trusted organizer workstation set `GOOGLE_AUTH_MODE=oauth`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN_FILE`. The file path should be new and in a private directory. Run:
   ```sh
   npm run google:setup -- oauth
   ```
3. Open the consent URL from the terminal on that workstation, sign in as the organizer, and grant access. The loopback callback verifies state and PKCE and writes the refresh token to a private file. Mount that file read-only on the server, or supply `GOOGLE_REFRESH_TOKEN` via a secret manager. Keep the client secret server-side. The public server does not expose OAuth routes.

The server refreshes access tokens automatically. External OAuth projects in Testing generally issue refresh tokens with a seven-day lifetime for these scopes. Complete applicable Google consent publishing and verification requirements before relying on unattended sync. If access is revoked or the refresh token expires, reauthorize with a fresh output path, update the server secret, restart, and run the Google setup checks. Pending registrations resume under their existing references.

### Google Workspace Shared Drive

Use a Shared Drive dedicated to the organizer and authorized staff. Grant the service account the permissions needed to create and read files, inspect permissions, edit the spreadsheet, and permanently delete the expired registration folders. Shared Drive Manager access is the practical option when permanent deletion is required. Set `GOOGLE_AUTH_MODE=service-account` and provide Application Default Credentials through a supported workload identity or a mounted credential file referenced by `GOOGLE_APPLICATION_CREDENTIALS`. Use the service account’s email in `GOOGLE_ALLOWED_EMAILS`. Service accounts use Shared Drive storage in this workflow.

### Prepare private resources

1. In the chosen Google account or Shared Drive, create a folder named **TAAKRA 2027 Registrations** and an empty Google spreadsheet inside it. Rename the worksheet tab to **Registrations**.
2. Set `GOOGLE_PARENT_FOLDER_ID` and `GOOGLE_SPREADSHEET_ID` from the organizer’s resource URLs. Add the organizer and only approved principals to `GOOGLE_ALLOWED_EMAILS`. If using an explicitly approved group, restrict and audit its membership.
3. Use **Restricted** sharing. Audit inherited permissions, including all Shared Drive members. Keep public and domain-wide sharing disabled. Staff should only change column N (review status) in the registration worksheet. Keep filters as personal filter views, and avoid sorting, moving, inserting, or deleting rows in the underlying tab. Row numbers are reserved in PostgreSQL and form part of the retry contract.
4. Configure `GOOGLE_ROW_LIMIT` for the total number of worksheet rows including the header. Before launching or increasing capacity, run:
   ```sh
   npm run google:setup -- prepare
   npm run google:setup -- verify
   ```
   Preparation expands the grid if needed and writes headers into row 1 if it is empty. Verification checks the folder, spreadsheet placement, approved sharing permissions, header, and grid capacity. Use a single DB and workbook pair. Never point multiple independent databases at one worksheet.

The worker reserves five Drive IDs before creating storage, verifies the expected folder and four files at those IDs, then writes the assigned spreadsheet row with **RAW** string values. It verifies access controls on the parent, spreadsheet and created Drive resources. Expired records are removed from the active worksheet and Drive (including their folder contents), and local document bytes are dropped after successful sync or at retention expiry. Cleanup of remote copies retries when Google access is unavailable. Set retention for managed backups and review Google version history, organizational retention, and recovery policies separately.

## Deploy

Use a long-running Node.js/container host with a private managed PostgreSQL database. The process runs the HTTP API and retry worker together and needs network access to PostgreSQL and Google. Use a database connection that supports PostgreSQL session advisory locks (a direct connection or session pool). Keep the database encrypted at rest, use TLS for remote DB connections, and limit its access to the application and operators. Keep `APP_SECRET` stable for the lifecycle of the database because it keys duplicate detection and receipt lookups.

Build and run the included image, or use the equivalent Node commands on your host.

```sh
docker build -t taakra-portal .
# Inject production configuration and secrets into both the migration job and the web service.
node dist-server/migrate.js
node dist-server/index.js
```

If your build network uses an organization CA, pass its trusted PEM bundle with `docker build --secret id=npm_ca,src=/path/to/trusted-ca.pem -t taakra-portal .`. The bundle is mounted only during dependency installation.

Inside the image, the equivalent one-off migration command is `node dist-server/migrate.js`. The Docker image starts the web service by default. For a host running from source, run `npm ci && npm run build` before the migration. Use `node dist-server/google-setup.js verify` to verify Google from a deployment without dev dependencies.

Set these production options:

- `NODE_ENV=production`, `PUBLIC_ORIGIN=https://<your-host>`, and `TRUST_PROXY_HOPS` to the exact trusted ingress hop count. The Node port should only be reachable from that ingress, which must terminate TLS, enforce HTTPS, and overwrite forwarded headers. Redirect HTTP at the edge.
- Configure a Cloudflare Turnstile widget for the public hostname. Set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. The browser uses the public key and the server verifies the challenge, hostname, and action.
- Allow the registration POST at least 21 MiB through the ingress. Preserve the multipart request’s `Content-Length`, with the edge buffering/dechunking uploads if necessary. Set a request timeout of at least 95 seconds. The API enforces a 5 MiB individual limit and a roughly 20 MiB aggregate limit. Choose a host without a smaller hard body limit.
- Allow outbound HTTPS to `www.googleapis.com`, `sheets.googleapis.com`, `oauth2.googleapis.com`, and `challenges.cloudflare.com`, plus any identity-provider endpoints required by your authentication method.
- Route the public origin to the Express service on port 3000. Use `/healthz` as the DB-backed liveness/readiness endpoint. Configure alerts on worker retry logs and monitor the count and age of pending and purging records. Avoid logging multipart bodies, form fields, private URLs, receipt headers, credentials, or Google response objects.

The app returns **Received — processing** once the database commits and **Registration complete** only after Google confirms all data writes. Students can check status while their tab is open. The retry key is opaque and stays in memory with the receipt. Uploaded documents and form fields are never written to browser storage.

## Verification

```sh
npm run build
# A disposable PostgreSQL DB is recommended. Tests create and drop their own schema.
TEST_DATABASE_URL='postgresql://taakra:taakra-local@127.0.0.1:5432/taakra' \
TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm test
```

The suite uses real PostgreSQL and the public HTTP API. It covers optional category submission, required fields and document checks, metadata removal, concurrent duplicates, client interruption, and worker recovery after lost Drive/Sheets responses using a simulated Google transport. Supply `TEST_CHROMIUM_EXECUTABLE` to run the desktop layout and mobile keyboard, reduced-motion, upload preview and pending-state browser checks. Without it the browser test is skipped.

Live Google acceptance needs the organizer’s configured environment. After `google:setup -- verify` succeeds, submit a synthetic registration over HTTPS without a category. Wait for **Registration complete** and download its receipt. In the organizer account, check the four readable files and matching spreadsheet row. Verify the category is **Not specified**, roll and mobile are strings, and review status is **Pending review**. Open the document and spreadsheet links from a signed-out browser and an account outside the approved staff list and confirm access is denied. Test on an actual mobile device for gallery and camera picker behavior.
