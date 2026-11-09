import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const password = () => randomBytes(24).toString('hex');
const content = `PGHOST=127.0.0.1\nPGPORT=55432\nPOSTGRES_PASSWORD=${password()}\nREQUESTS_PASSWORD=${password()}\nASSETS_PASSWORD=${password()}\n`;
try {
  writeFileSync(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('.env criado com senhas locais aleatórias.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env já existe; configuração preservada.');
}
