# TAAKRA 2027 student registration

A public, account-free registration portal with a React frontend, an Express API, PostgreSQL, and a background worker for Google Drive and Sheets. The public site validates applications and collects documents for organizer review.

## Run locally

Use Node.js 22.12 or newer and a running Docker Compose installation.

```sh
npm run setup
```

This installs the locked dependencies, fills missing development settings in `.env`, starts local PostgreSQL, applies the schema, and starts the API and frontend. The generated app secret is reused on subsequent runs. The default retention is seven days for development. If you set a custom `DATABASE_URL`, setup uses that database instead of starting Docker, so make sure it is a development database with schema creation privileges.

Open `http://localhost:5173` after both servers start. To restart the app while PostgreSQL is running, use `npm run dev`. To try the built bundle locally, run `npm run build` and `npm start`, then open `http://localhost:3000`. See [the environment example](.env.example) for optional settings such as `ORGANIZER_NAME` and `ORGANIZER_EMAIL`.

Development can run without Google and Turnstile. Submissions save to PostgreSQL and show **Received — processing** until a configured Google worker completes them. Use synthetic forms and images during development.

The included [illustration](public/taakra-art.webp) was generated from the written brief. Replace it with the official artwork at that path before launch. If its aspect ratio differs, update the image dimensions and alt text in [Hero.tsx](src/Hero.tsx). The browser renders the image at its native aspect ratio.

## Google setup

Enable the **Drive API** and **Sheets API** in an organizer-controlled Google Cloud project. Use a dedicated organizer account where possible. Choose one authentication path.

### Organizer’s personal Google account

Create a **Web application** OAuth client in the organizer’s Google Cloud project. Configure its consent screen and add the exact authorized redirect URI `http://127.0.0.1:53682/oauth/callback`. On the organizer’s workstation, set `GOOGLE_AUTH_MODE=oauth`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_ALLOWED_EMAILS` to the organizer’s email and any explicitly approved staff. Then run the provisioning command below.

If an organizer token is missing, the command prints a consent URL. Open it on that workstation, sign in as the organizer, and approve access. The loopback callback verifies state and PKCE, saves the refresh token in `.taakra-google-oauth.secret` (or the configured `GOOGLE_REFRESH_TOKEN_FILE`), and continues provisioning.

The server refreshes access tokens automatically. External OAuth projects in Testing generally issue refresh tokens with a seven-day lifetime for these scopes. Complete applicable Google consent publishing and verification requirements for unattended sync. If a token expires or access is revoked, run `npm run google:setup -- oauth` with a fresh `GOOGLE_REFRESH_TOKEN_FILE` path. Update the server secret, restart, and rerun the Google setup checks. Pending registrations resume under their existing references.

### Google Workspace Shared Drive

Use a Shared Drive dedicated to the organizer and authorized staff. Grant the service account the permissions needed to create and read files, inspect permissions, edit the spreadsheet, and permanently delete expired registration folders. Shared Drive Manager access is the practical option when permanent deletion is required. Set `GOOGLE_AUTH_MODE=service-account` and provide Application Default Credentials through a supported workload identity or a mounted credential file referenced by `GOOGLE_APPLICATION_CREDENTIALS`. Set `GOOGLE_SHARED_DRIVE_ID` to the destination drive’s ID and include the service account and authorized drive members in `GOOGLE_ALLOWED_EMAILS`.

### Create and verify private resources

```sh
npm run google:setup -- provision
npm run google:setup -- verify
```

Provisioning creates **TAAKRA 2027 Registrations** in My Drive or the selected Shared Drive, creates a spreadsheet inside it, adds the **Registrations** tab at the configured capacity, and writes the headers. It verifies permissions and saves the resource IDs in the private `.taakra-google.secret` file (override with `GOOGLE_RESOURCES_FILE`). Rerun with the same file to resume setup or verify that the resources are ready. If the Drive request to create the spreadsheet was interrupted, the command looks for the original spreadsheet before making further changes. A previous spreadsheet creation with an unknown outcome requires reconciliation in Drive if it stays unresolved after retry. Remove a leftover `<provisioning-file>.lock.secret` only after confirming the prior command has stopped.

Mount the finished resource file read-only at the server’s configured path, or set both `GOOGLE_PARENT_FOLDER_ID` and `GOOGLE_SPREADSHEET_ID` in the server environment. Mount the OAuth refresh-token file read-only or supply `GOOGLE_REFRESH_TOKEN` with your secret manager. Keep the OAuth client secret and both files out of source control. Restart the server after configuring access. The public server exposes no OAuth or provisioning routes.

If you already have a private folder and its spreadsheet, set both resource IDs and use `npm run google:setup -- prepare` followed by `npm run google:setup -- verify`. The folder must be named **TAAKRA 2027 Registrations** and the sheet must already have a **Registrations** tab. Set `GOOGLE_ROW_LIMIT` and rerun `prepare` to expand capacity. Use a single database and workbook pair.

Keep Google sharing **Restricted** and audit inherited permissions and approved group membership. Provisioning does not add collaborators. Staff should only change column N (review status) and use personal filter views. Row numbers are part of the retry contract, so avoid sorting, moving, inserting, or deleting rows in the underlying tab.

The worker reserves five Drive IDs before creating storage, verifies the expected folder and four files at those IDs, then writes the assigned spreadsheet row with **RAW** string values. It verifies access controls on the parent, spreadsheet and created Drive resources. Expired records are removed from the active worksheet and Drive (including their folder contents), and local document bytes are dropped after successful sync or at retention expiry. Cleanup of remote copies retries when Google access is unavailable. Set retention for managed backups and review Google version history, organizational retention, and recovery policies separately.

## Deploy

Use a long-running Node.js/container host with a private managed PostgreSQL database. The process runs the HTTP API and retry worker together and needs network access to PostgreSQL and Google. Use a database connection that supports PostgreSQL session advisory locks (a direct connection or session pool). Keep the database encrypted at rest, use TLS for remote DB connections, and limit its access to the application and operators. Keep `APP_SECRET` stable for the lifecycle of the database because it keys duplicate detection and receipt lookups.

Build the app, then configure the production variables in your host’s environment or secret manager. Set an approved `RETENTION_DAYS` value and generate a dedicated, stable production `APP_SECRET`.

For a source deployment, run `npm ci && npm run build` and set the start command to:

```sh
npm run start:deploy
```

For a container deployment, build with `docker build -t taakra-portal .` and set the container command to `node dist-server/index.js --migrate`. Both start commands apply the schema before accepting traffic and require database migration privileges. The migrations are safe to rerun and are serialized across concurrent starts.

If the application uses a separate, restricted database role, run `node dist-server/migrate.js` as a one-off release job with the migration role, then use the image’s default command or `npm start` for the web service.

If your build network uses an organization CA, pass its trusted PEM bundle with `docker build --secret id=npm_ca,src=/path/to/trusted-ca.pem -t taakra-portal .`. The bundle is mounted only during dependency installation. Use `node dist-server/google-setup.js verify` to verify Google in a deployment without development dependencies.

Set these production options:

- `NODE_ENV=production`, `PUBLIC_ORIGIN=https://<your-host>`, and `TRUST_PROXY_HOPS` to the exact trusted ingress hop count. The Node port should only be reachable from that ingress, which must terminate TLS, enforce HTTPS, and overwrite forwarded headers. Redirect HTTP at the edge.
- Configure a Cloudflare Turnstile widget for the public hostname. Set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. The browser uses the public key and the server verifies the challenge, hostname, and action.
- Allow the registration POST at least 21 MiB through the ingress. Preserve the multipart request’s `Content-Length`, with the edge buffering/dechunking uploads if necessary. Set a request timeout of at least 95 seconds. The API enforces a 5 MiB individual limit and a roughly 20 MiB aggregate limit. Choose a host without a smaller hard body limit.
- Allow outbound HTTPS to `www.googleapis.com`, `sheets.googleapis.com`, `oauth2.googleapis.com`, and `challenges.cloudflare.com`, plus any identity-provider endpoints required by your authentication method.
- Route the public origin to the Express service on port 3000. Use `/healthz` as the DB-backed liveness/readiness endpoint. Configure alerts on worker retry logs and monitor the count and age of pending and purging records. Avoid logging multipart bodies, form fields, private URLs, receipt headers, credentials, or Google response objects.

The app returns **Received — processing** once the database commits and **Registration submitted** only after Google confirms all data writes. Students can check status while their tab is open. The retry key is opaque and stays in memory with the receipt. Uploaded documents and form fields are never written to browser storage.

## Verification

```sh
npm run build
# A disposable PostgreSQL DB is recommended. Tests create and drop their own schema.
TEST_DATABASE_URL='postgresql://taakra:taakra-local@127.0.0.1:5432/taakra' \
TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm test
```

The suite uses real PostgreSQL and the public HTTP API. It covers Google provisioning retries and permission checks against a test-only transport, manual student details, optional category, required fields and document checks, metadata removal, concurrent duplicates, client interruption, and worker recovery after lost Drive/Sheets responses using a test-only Google transport. Supply `TEST_CHROMIUM_EXECUTABLE` to check viewport widths, mobile keyboard focus, hero links, reduced motion, upload previews, retry and receipt download. Without it the browser test is skipped.

Live Google acceptance needs the organizer’s configured environment. After `google:setup -- verify` succeeds, submit a synthetic registration over HTTPS without a category. Wait for **Registration submitted** and download its receipt. Confirm both use Pakistan time. In the organizer account, check the four readable files and matching spreadsheet row. Verify the category is **Not specified**, roll and mobile are strings, and review status is **Pending review**. Open the document and spreadsheet links from a signed-out browser and an account outside the approved staff list and confirm access is denied. Test on an actual mobile device for gallery and camera picker behavior.
