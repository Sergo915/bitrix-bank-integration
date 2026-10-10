// Production is served by Nginx, which proxies /api on this same origin.
// A local development URL must never be embedded in the deployed app.
export const API_BASE_URL = import.meta.env.PROD
  ? ''
  : (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000');
