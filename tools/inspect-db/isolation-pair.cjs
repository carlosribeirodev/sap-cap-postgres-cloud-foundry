const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Client } = require('pg')
const bindings = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat()
const specs = {
  requests: { table: 'lab_requests_requests', field: 'title', extra: 'status' },
  assets: { table: 'lab_assets_assets', field: 'name', extra: 'serialnumber' }
}

async function main() {
  const first = bindings.find(binding => binding.name === 'cap-lab-requests-runtime-db')?.credentials
  const second = bindings.find(binding => binding.name === 'cap-lab-assets-runtime-db')?.credentials
  assert(first && second, 'Both runtime bindings are required')
  assert.equal(first.host, second.host)
  assert.equal(Number(first.port), Number(second.port))
  for (const field of ['database', 'schema', 'user']) assert.notEqual(first[field], second[field])
  console.log('CAP_PAIR_ISOLATION ' + JSON.stringify({ sameInstanceEndpoint: true, separateDatabases: true, separateSchemas: true, separateUsers: true }))
  for (const [app, spec] of Object.entries(specs)) {
    const c = bindings.find(binding => binding.name === `cap-lab-${app}-runtime-db`)?.credentials
    assert(c, 'Missing runtime binding')
    assert.equal(c.database, `cap_lab_${app}_db`)
    assert.equal(c.schema, `cap_lab_${app}`)
    assert.equal(c.user, `cap_lab_${app}_runtime`)
    const client = new Client({ ...c, connectionTimeoutMillis: 10000, query_timeout: 10000 })
    try {
      await client.connect()
      await client.query(`SET search_path TO "cap_lab_${app}"`)
      const context = await client.query('SELECT current_database() AS db,current_schema() AS schema')
      assert.equal(context.rows[0].db, `cap_lab_${app}_db`)
      assert.equal(context.rows[0].schema, `cap_lab_${app}`)
      const role = await client.query('SELECT rolcreatedb,rolcreaterole,rolsuper FROM pg_roles WHERE rolname=current_user')
      assert.deepEqual(role.rows[0], { rolcreatedb: false, rolcreaterole: false, rolsuper: false })
      await client.query('BEGIN')
      try {
        const id = randomUUID()
        await client.query(`INSERT INTO ${spec.table} (id,${spec.field},${spec.extra}) VALUES ($1,$2,$3)`, [id, 'Isolation test', 'TEST'])
        const read = await client.query(`SELECT ${spec.field} AS value FROM ${spec.table} WHERE id=$1`, [id])
        assert.equal(read.rows[0].value, 'Isolation test')
        await client.query(`UPDATE ${spec.table} SET ${spec.extra}=$2 WHERE id=$1`, [id, 'UPDATED'])
        const updated = await client.query(`SELECT ${spec.extra} AS value FROM ${spec.table} WHERE id=$1`, [id])
        assert.equal(updated.rows[0].value, 'UPDATED')
        await client.query(`DELETE FROM ${spec.table} WHERE id=$1`, [id])
      } finally { await client.query('ROLLBACK') }
      await client.query('BEGIN')
      try {
        await assert.rejects(() => client.query(`CREATE TABLE "cap_lab_${app}".runtime_forbidden (id integer)`), error => error.code === '42501')
      } finally { await client.query('ROLLBACK') }
    } finally { await client.end().catch(() => {}) }
    const otherApp = app === 'requests' ? 'assets' : 'requests'
    const denied = new Client({ ...c, database: `cap_lab_${otherApp}_db`, connectionTimeoutMillis: 10000 })
    try {
      await assert.rejects(() => denied.connect(), error => error.code === '42501')
    } finally { await denied.end().catch(() => {}) }
    console.log('CAP_PAIR_ISOLATION ' + JSON.stringify({ app, ownDatabaseAndSchema: true, crud: true, persistentDDLBlocked: true, crossDatabaseDenied: true }))
  }
}
main().catch(error => {
  console.log('CAP_PAIR_ISOLATION ' + JSON.stringify({ ok: false, errorCode: error.code || 'ASSERTION_FAILED' }))
  process.exitCode = 1
})
