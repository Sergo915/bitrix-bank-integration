import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

const currentDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(currentDir, '../../../../.env') });
config();

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());
const optionalString = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());
const optionalBoolean = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : String(value).toLowerCase() === 'true'),
  z.boolean().optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVER_PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: optionalUrl.default('http://localhost:5173'),
  BITRIX_ALLOWED_DOMAINS: optionalString,
  BITRIX_CLIENT_ID: optionalString,
  BITRIX_CLIENT_SECRET: optionalString,
  BITRIX_REDIRECT_URI: optionalUrl,
  BITRIX_SESSION_SECRET: optionalString,
  BITRIX_SESSION_COOKIE_NAME: optionalString.default('milon_bitrix_session'),
  BITRIX_SESSION_TTL_MS: z.coerce.number().int().min(300000).max(86400000).default(3600000),
  BITRIX_INSTALLATION_STORE_PATH: optionalString.default('data/bitrix-installations.json'),
  BITRIX_APPLICATION_TOKEN: optionalString,
  CLIENT_DIST_PATH: optionalString.default('apps/client/dist'),
  BITRIX_WEBHOOK_URL: optionalUrl,
  BITRIX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10000).max(300000).default(90000),
  AMERIA_BASE_URL: optionalUrl,
  Ameria_access_Key: optionalString,
  AMERIA_APPLICATION_NAME: optionalString.default('MilonAmeriaIntegration'),
  AMERIA_PROXY_URL: optionalString,
  AMERIA_CLIENT_ID: optionalString,
  AMERIA_CLIENT_SECRET: optionalString,
  AMERIA_USERNAME: optionalString,
  AMERIA_PASSWORD: optionalString,
  AMERIA_AUTH_PATH: optionalString.default('/authentication/v1/authenticate'),
  AMERIA_REFRESH_PATH: optionalString.default('/authentication/v1/refresh'),
  AMERIA_AUTH_MODE: z.enum(['json', 'form']).default('json'),
  AMERIA_ACCOUNTS_PATH: optionalString.default('/accounts/v1/get-list'),
  AMERIA_TRANSACTIONS_PATH: optionalString.default('/accounts/v1/transactions'),
  AMERIA_SYNC_ENABLED: optionalBoolean.default(false),
  AMERIA_SYNC_RUN_ON_START: optionalBoolean.default(false),
  AMERIA_SYNC_INTERVAL_MS: z.coerce.number().int().min(60000).default(300000),
  AMERIA_SYNC_FROM_DATE: optionalString.default('2026-01-01'),
  AMERIA_SCHEDULER_STATE_PATH: optionalString.default('data/ameria-scheduler-state.json'),
  ACTIVITY_LOG_PATH: optionalString,
  DB_HOST: optionalString,
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_NAME: optionalString.default('milon_ameria'),
  DB_USER: optionalString,
  DB_PASSWORD: optionalString,
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().max(100).default(10),
  ADMIN_ACCESS_TOKEN: optionalString,
  BITRIX_REFRESH_STAGE_IDS: optionalBoolean.default(false),
  // Additive matching layer (smartMatch.js + parsePurposeV2). Off by default: while it is false
  // the legacy parser and the legacy suggestion order stay byte-for-byte unchanged.
  SMART_MATCH_V2: optionalBoolean.default(false)
});

export const env = envSchema.parse(process.env);

