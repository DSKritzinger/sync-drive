# Sync Drive

Sync Drive is an unofficial Obsidian plugin that synchronizes a vault
through Google Drive. It is not the official [Obsidian Sync](https://obsidian.md/sync)
service.

The plugin requires a small self-hosted auth service. There is no default hosted
service: every Obsidian installation must be configured with your auth server URL
and proxy key.

## Important safety notes

**Always make a separate backup of your vault before enabling or migrating this
plugin.**

- Start initial setup in an empty vault. To add existing notes, copy or drag them
  into the vault through Obsidian after setup so the plugin observes the changes.
- Do not combine this plugin with another tool that directly synchronizes the same
  Google Drive files.
- Do not manually upload into the Google Drive folder created by the plugin.
- Avoid changing vault files outside Obsidian while the plugin is enabled.
- Sync before switching devices, and use a reliable connection. Conflict handling
  favors unsynced local changes but is not a substitute for backups.
- Do not change the Obsidian configuration folder for an active synced vault.

## Features

- Pull and push synchronization with Google Drive
- Cross-device and Obsidian iOS support
- Multiple vaults per Google account
- Obsidian configuration and supported plugin-file synchronization
- Automatic conflict handling with local-file prioritization

## Self-hosted auth server

The server in [`auth-server`](auth-server) keeps the Google OAuth client secret
out of the Obsidian plugin. It provides:

- `GET /api/ping` for health checks
- `POST /api/access` for exchanging a refresh token for a short-lived access token
- `GET /auth` and `GET /callback` for issuing a refresh token

### 1. Create a Google OAuth client

In Google Cloud:

1. Configure an OAuth consent screen.
2. Create an OAuth 2.0 **Web application** client.
3. Add this exact authorized redirect URI:
   `${PUBLIC_BASE_URL}/callback`
4. Keep the scope
   `https://www.googleapis.com/auth/drive.file`.

The narrow `drive.file` scope is intentional. A self-hosted deployment starts a
fresh remote vault and only needs access to files created through that OAuth
application.

### 2. Configure the server

From `auth-server`, copy `.env.example` to `.env` and set:

```dotenv
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
PUBLIC_BASE_URL=https://auth.example.com
AUTH_PROXY_KEY=generate-a-long-random-value
GOOGLE_DRIVE_SCOPE=https://www.googleapis.com/auth/drive.file
PORT=8787
```

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL`, and
`AUTH_PROXY_KEY` are required. Generate a unique high-entropy proxy key, for
example with `openssl rand -base64 32`, and do not publish `.env`.

Optional settings:

- `ALLOWED_ORIGINS` is a comma-separated CORS allowlist and defaults to `*`.
- `SECURE_COOKIES=false` disables the OAuth state's Secure cookie flag for
  loopback-only local development.
- `REQUIRE_AUTH_PROXY_KEY=false` disables proxy-key verification. This is only
  intended for isolated local testing and must not be used in production.

Start the service:

```sh
cd auth-server
npm start
```

The included Docker, Compose, and Caddy examples can be used for deployment.
Production and Tailnet deployments must expose `PUBLIC_BASE_URL` over HTTPS.
Plain HTTP is supported by the plugin only for loopback development URLs using
`localhost`, `127.0.0.1`, or `[::1]`.

### 3. Configure Obsidian

1. Open the Sync Drive settings.
2. Enter the auth server URL. Trailing slashes are removed automatically.
3. Enter the same value used for the server's `AUTH_PROXY_KEY`.
4. Follow the settings-page link to `${authServerUrl}/auth`.
5. Complete Google authorization and copy the displayed refresh token.
6. Paste it into the plugin settings and choose **Validate and save**.
7. Reload Obsidian.

The auth server URL and proxy key are required before authentication or sync.
The proxy key and refresh token are stored in plaintext in Obsidian's local
plugin data, so protect access to the device and vault configuration.

## Migrating from another OAuth client

Google refresh tokens are bound to the OAuth client that issued them. An old
refresh token cannot be reused with this self-hosted server; obtain a new token
from this server's `/auth` route.

Remote files created through the old OAuth client are not migrated
automatically. Use this manual procedure:

1. Complete one final sync with the old setup.
2. Make a separate, verified backup of the local vault.
3. Create a new empty vault for the self-hosted setup.
4. Enable and configure the plugin while that vault is empty.
5. Copy or drag the backed-up content into the vault through Obsidian.
6. Push the observed changes and verify the new Google Drive vault before
   retiring the backup.

## Using the plugin

- When Obsidian opens, the plugin pulls changes from Google Drive.
- Run **Pull from Google Drive** to pull manually.
- Use the ribbon sync button or **Push to Google Drive** to review and push local
  changes. A push pulls remote changes first.
- Run **Reset local vault to Google Drive** only when you intentionally want to
  discard local changes in favor of the remote state.
- Vaults are matched by their internal local vault name. Do not rename an active
  local synced vault.

## Privacy and security

The plugin communicates with:

- Google Drive APIs to list, download, create, update, and delete synchronized
  vault files.
- The configured self-hosted auth server for health checks and access-token
  refresh.

The auth server receives the refresh token in memory when proxying a token
request to Google. This implementation does not persist the token or vault
contents. Its operator still controls the host and logs, so only use a server you
trust. The auth server never receives vault file contents; synchronization goes
directly between the plugin and Google Drive.

## Tests

The auth server tests use Node's built-in test runner, inline dummy
configuration, mocked Google responses, and ephemeral loopback ports. They do
not read `.env`, use real credentials, or make external network requests.

```sh
cd auth-server
npm test
```

The suite covers health and routing, CORS, proxy-key enforcement, request
validation, Google token proxying, OAuth redirects and state validation, safe
refresh-token rendering, and missing-token guidance.
