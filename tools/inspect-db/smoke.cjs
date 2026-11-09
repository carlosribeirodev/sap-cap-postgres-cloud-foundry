const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Client } = require('pg')
const bindings = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat()
const c = bindings.find(b => b.name === 'cap-lab-requests-runtime-db')?.credentials

async function main() {
  assert(c, 'Runtime binding missing')
  const client = new Client({ ...c, connectionTimeoutMillis: 10000, query_timeout: 10000 })
  try {
    await client.connect()
    await client.query('SET search_path TO cap_lab_requests')
    const role = await client.query('SELECT rolcreatedb, rolcreaterole, rolsuper FROM pg_roles WHERE rolname=current_user')
    assert.deepEqual(role.rows[0], { rolcreatedb: false, rolcreaterole: false, rolsuper: false })
    await client.query('BEGIN')
    const id = randomUUID()
    await client.query('INSERT INTO lab_requests_requests (id,title,status) VALUES ($1,$2,$3)', [id, 'Validação temporária CAP', 'OPEN'])
    const read = await client.query('SELECT title FROM lab_requests_requests WHERE id=$1', [id])
    assert.equal(read.rows[0].title, 'Validação temporária CAP')
    await client.query('UPDATE lab_requests_requests SET status=$2 WHERE id=$1', [id, 'DONE'])
    await client.query('DELETE FROM lab_requests_requests WHERE id=$1', [id])
    await client.query('ROLLBACK')
    await client.query('BEGIN')
    try {
      await assert.rejects(() => client.query('CREATE TABLE cap_lab_requests.runtime_must_not_create (id integer)'), error => error.code === '42501')
    } finally { await client.query('ROLLBACK') }
    console.log('CAP_PG_SMOKE ' + JSON.stringify({ crud: true, persistentDDLBlocked: true, noAdminPrivileges: true }))
  } finally { await client.end().catch(() => {}) }
  const other = new Client({ ...c, database: 'cap_lab_assets_db', connectionTimeoutMillis: 10000 })
  try {
    await assert.rejects(() => other.connect(), error => error.code === '42501')
    console.log('CAP_PG_SMOKE ' + JSON.stringify({ crossDatabaseDenied: true }))
  } finally { await other.end().catch(() => {}) }
}
main().catch(error => {
  console.log('CAP_PG_SMOKE ' + JSON.stringify({ ok: false, errorCode: error.code || 'ASSERTION_FAILED' }))
  process.exitCode = 1
})
