const { Client } = require('pg')

async function inspect() {
  const bindings = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat()
  const binding = bindings.find(b => b.name === process.env.LAB_POSTGRES_SERVICE)
  if (!binding) throw Object.assign(new Error(), { code: 'BINDING_MISSING' })
  const c = binding.credentials
  const client = new Client({
    host: c.hostname || c.host,
    port: Number(c.port || 5432),
    user: c.username || c.user,
    password: c.password,
    database: c.dbname || c.database,
    ssl: { ...(c.sslrootcert ? { ca: c.sslrootcert } : {}), rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
    query_timeout: 10000
  })
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    const role = await client.query('SELECT rolcreatedb, rolcreaterole, rolsuper FROM pg_roles WHERE rolname=current_user')
    const db = await client.query("SELECT has_database_privilege(current_database(),'CREATE') AS can_create_schema, pg_get_userbyid(datdba)=current_user AS owns_database FROM pg_database WHERE datname=current_database()")
    const schemas = await client.query("SELECT count(*)::int AS writable_schemas FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' AND has_schema_privilege(oid,'CREATE')")
    const tls = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')
    console.log('CAP_PG_INSPECTION ' + JSON.stringify({ connected: true, role: role.rows[0], database: db.rows[0], schemas: schemas.rows[0], tls: tls.rows[0] }))
    await client.query('ROLLBACK')
  } finally {
    await client.end().catch(() => {})
  }
}

inspect().catch(error => {
  // Nunca registrar Error, connection string, binding ou VCAP_SERVICES.
  console.log('CAP_PG_INSPECTION ' + JSON.stringify({ connected: false, errorCode: error.code || 'CONNECTION_OR_QUERY_FAILED' }))
  process.exitCode = 1
})
