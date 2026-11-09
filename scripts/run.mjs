import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connection, root } from './config.mjs';

const [app, action] = process.argv.slice(2);
if (!['serve', 'deploy'].includes(action)) throw new Error('Ação inválida.');
const credentials = connection(app);
const env = { ...process.env, NODE_ENV: 'development' };
// Este executor é exclusivamente local. Credenciais chegam pelo ambiente, não pelo argv.
env.cds_requires_db_credentials = JSON.stringify(credentials);
env.PORT = app === 'requests' ? '4004' : '4005';
const args = action === 'deploy' ? ['deploy', '--to', 'postgres'] : ['serve', 'all'];
const child = spawn(fileURLToPath(new URL('node_modules/.bin/cds', root)), args, {
  cwd: fileURLToPath(new URL(`apps/${app}/`, root)), env, stdio: 'inherit'
});
child.on('error', () => { console.error('Falha ao iniciar CDS. Execute npm ci.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
