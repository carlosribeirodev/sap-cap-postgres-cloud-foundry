import assert from 'node:assert/strict';
import pg from 'pg';
import { connection } from './config.mjs';

for (const app of ['requests', 'assets']) {
  const own = connection(app);
  const client = new pg.Client(own);
  try {
    await client.connect();
    const result = await client.query('SELECT current_database() AS db, current_schema() AS schema');
    assert.equal(result.rows[0].db, `${app}_db`);
    assert.equal(result.rows[0].schema, app);
    // O modelo de evolução também precisa ser exclusivo da aplicação.
    await client.query('SELECT 1 FROM cds_model LIMIT 1');
    console.log(`${app}: banco, schema e modelo CAP encontrados.`);
  } finally {
    await client.end();
  }

  const otherDb = app === 'requests' ? 'assets_db' : 'requests_db';
  const denied = new pg.Client({ ...own, database: otherDb });
  try {
    await assert.rejects(() => denied.connect(), error => error.code === '42501',
      `${app} não deve conseguir conectar ao banco da outra aplicação`);
    console.log(`${app}: conexão ao outro banco recusada como esperado.`);
  } finally {
    await denied.end();
  }
}
