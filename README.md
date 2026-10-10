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

## Security and automatic sync

- Set `BITRIX_ALLOWED_DOMAINS` to the comma-separated Bitrix domains allowed to complete OAuth. The webhook domain is allowed automatically.
- Set `AMERIA_AUTH_PATH`, `AMERIA_AUTH_MODE` and `AMERIA_TRANSACTIONS_PATH` from Ameriabank's final API specification.
- Enable the scheduler with `AMERIA_SYNC_ENABLED=true`. Configure its interval with `AMERIA_SYNC_INTERVAL_MS` (minimum 60000 ms).
- Scheduler start/stop state and its selected start date/time are persisted in `AMERIA_SCHEDULER_STATE_PATH`, so closing the admin page or restarting the service does not reset the choice.
- Activity history is stored in `data/activity-log.json` by default. Override it with `ACTIVITY_LOG_PATH` when persistent storage is mounted elsewhere.
- Smart Match V2 is documented in [`docs/smart-match.md`](docs/smart-match.md). Keep it in shadow mode until live matching results have been reviewed, then enable it with `SMART_MATCH_V2=true`.

## Bitrix24 Local Application

For the server-side Local Application, configure these Bitrix24 URLs after deploying the client build:

- Initial installation path: `https://bitrixameria.duckdns.org/api/bitrix/install`
- Handler path: `https://bitrixameria.duckdns.org/api/bitrix/app`
- Enable `Application completes installation itself` when no installation wizard is needed.

The application accepts Bitrix24 authorization only through the signed installation/session flow. Direct browser access to the handler is rejected, API routes require the Bitrix session, and Bitrix deal navigation uses the in-portal `BX24.openPath` method.

Set `BITRIX_SESSION_SECRET` to a long random value in the production `.env`. Do not commit `BITRIX_CLIENT_SECRET`, `BITRIX_APPLICATION_TOKEN`, access tokens, refresh tokens, webhook URLs, or other secrets.

## Production update

The production service starts the compiled server from `apps/server/dist`, so rebuild after pulling source changes before restarting systemd:

```bash
cd /var/www/milon-ameria
git pull --ff-only origin main
npm ci
npm run build
sudo systemctl restart milon-ameria
sudo systemctl status milon-ameria --no-pager
```
