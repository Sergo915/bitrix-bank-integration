import mysql from 'mysql2/promise';

let pool;

function getDbConfig() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    name: process.env.DB_NAME ?? 'milon_ameria',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 10)
  };
}

export function isDatabaseConfigured() {
  const config = getDbConfig();
  return Boolean(config.host && config.name && config.user);
}

export function getDatabasePool() {
  const config = getDbConfig();

  if (!isDatabaseConfigured()) {
    throw new Error('MySQL is not configured. Set DB_HOST, DB_NAME, DB_USER and DB_PASSWORD.');
  }

  pool ??= mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.name,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4'
  });

  return pool;
}

export async function closeDatabasePool() {
  if (!pool) return;
  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}