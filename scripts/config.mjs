import { loadEnvFile } from 'node:process';

export const root = new URL('../', import.meta.url);
export function connection(app) {
  loadEnvFile(new URL('../.env', import.meta.url));
  if (!['requests', 'assets'].includes(app)) throw new Error('Aplicação inválida.');
  const password = process.env[`${app.toUpperCase()}_PASSWORD`];
  if (!password) throw new Error('Execute npm run setup e configure .env.');
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 55432),
    database: `${app}_db`,
    user: `${app}_user`,
    password,
    connectionTimeoutMillis: 5000
  };
}
