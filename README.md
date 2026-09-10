# Bitrix24 Cloud + Ameriabank Integration

Node.js + React.js project for integrating Bitrix24 Cloud workflows with Ameriabank Corporate API.

## Structure

- `apps/server` - Express API, Bitrix OAuth entry points, Ameriabank service client.
- `apps/client` - React/Vite dashboard for connection status and integration actions.
- `docs` - implementation notes and API mapping.

## Run locally

```bash
npm install
npm run dev
```

On Windows PowerShell, if `npm` is blocked by execution policy, use:

```bash
npm.cmd install
npm.cmd run dev
```

Copy `.env.example` to `.env` and fill in Bitrix24 and Ameriabank credentials.

For production, set `NODE_ENV=production` and leave `AMERIA_PROXY_URL` empty. The server then connects to Ameriabank directly from its public IP. The SOCKS proxy is used only for local development.

Production server setup:

```bash
npm ci
npm run build
npm --workspace apps/server run start
```

Set the production values in `.env` before starting the server. The server needs the database variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`) and `ADMIN_ACCESS_TOKEN`; keep `.env` on the server only and never commit it.

## Security and automatic sync

- Set `BITRIX_AUTH_REQUIRED=true` in production. The client accepts Bitrix launch parameters, verifies the user with `user.current`, and stores each user/session in MySQL. Direct browser access without a Bitrix session is rejected.
- Set `BITRIX_ALLOWED_DOMAINS` to the comma-separated Bitrix domains allowed to complete OAuth. The webhook domain is allowed automatically.
- Set `AMERIA_AUTH_PATH`, `AMERIA_AUTH_MODE` and `AMERIA_TRANSACTIONS_PATH` from Ameriabank's final API specification.
- Enable the scheduler with `AMERIA_SYNC_ENABLED=true`. Configure its interval with `AMERIA_SYNC_INTERVAL_MS` (minimum 60000 ms).
- Activity history is stored in `data/activity-log.json` by default. Override it with `ACTIVITY_LOG_PATH` when persistent storage is mounted elsewhere.
- Smart Match V2 is documented in [`docs/smart-match.md`](docs/smart-match.md). Keep it in shadow mode until live matching results have been reviewed, then enable it with `SMART_MATCH_V2=true`.
