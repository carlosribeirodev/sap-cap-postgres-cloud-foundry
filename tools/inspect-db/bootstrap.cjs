const { Client } = require('pg')
const bindings = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat()
const admin = bindings.find(b => b.name === process.env.LAB_POSTGRES_SERVICE)?.credentials
const plan = bindings.find(b => b.name === 'cap-lab-bootstrap-input')?.credentials
const qi = s => '"' + s.replaceAll('"', '""') + '"'
const ql = s => "'" + s.replaceAll("'", "''") + "'"
let step = 'connect'
const config = database => ({
  host: admin.hostname || admin.host, port: Number(admin.port || 5432),
  user: admin.username || admin.user, password: admin.password,
  database: database || admin.dbname || admin.database,
  ssl: { ca: admin.sslrootcert, rejectUnauthorized: true },
  connectionTimeoutMillis: 10000, query_timeout: 15000
})

async function main() {
  if (!admin || !plan?.apps?.length) throw Object.assign(new Error(), { code: 'MISSING_BINDING' })
  const client = new Client(config())
  try {
    await client.connect()
    if (plan.mode === 'inspect') {
      const identity = await client.query("SELECT current_user=$1 AS binding_matches_current, session_user=$1 AS binding_matches_session, current_user=session_user AS same_effective_role, current_setting('server_version') AS server_version", [admin.username || admin.user])
      console.log('CAP_PG_BOOTSTRAP ' + JSON.stringify({ identity: identity.rows[0] }))
      for (const app of plan.apps) {
        const roles = await client.query('SELECT rolname, rolcreatedb, rolcreaterole, rolsuper FROM pg_roles WHERE rolname=ANY($1)', [[app.deployer, app.runtime]])
        const databases = await client.query('SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [app.database])
        console.log('CAP_PG_BOOTSTRAP ' + JSON.stringify({ app: app.id, existingRoles: roles.rows, existingDatabases: databases.rows }))
        if (roles.rows.some(role => role.rolname === app.deployer)) {
          const membership = await client.query("SELECT pg_has_role(current_user,$1,'SET') AS current_can_set, pg_has_role(session_user,$1,'SET') AS session_can_set, pg_has_role(current_user,$1,'MEMBER') AS current_is_member", [app.deployer])
          console.log('CAP_PG_BOOTSTRAP ' + JSON.stringify({ app: app.id, membership: membership.rows[0] }))
        }
      }
      return
    }
    // Não modificar recursos existentes nem trocar senhas silenciosamente.
    for (const app of plan.apps) {
      for (const value of [app.database, app.schema, app.deployer, app.runtime]) {
        if (!/^cap_lab_[a-z_]+$/.test(value)) throw Object.assign(new Error(), { code: 'INVALID_NAME' })
      }
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=ANY($2)', [app.database, [app.deployer, app.runtime]])
      if (existing.rowCount && plan.mode !== 'resume') throw Object.assign(new Error(), { code: 'RESOURCES_ALREADY_EXIST' })
    }
    for (const app of plan.apps) {
      step = app.id + ':roles'
      for (const [name, password] of [[app.deployer, app.deployerPassword], [app.runtime, app.runtimePassword]]) {
        const role = await client.query('SELECT rolcreatedb,rolcreaterole,rolsuper,rolcanlogin FROM pg_roles WHERE rolname=$1', [name])
        if (!role.rowCount) await client.query(`CREATE ROLE ${qi(name)} LOGIN PASSWORD ${ql(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE`)
        else if (role.rows[0].rolcreatedb || role.rows[0].rolcreaterole || role.rows[0].rolsuper || !role.rows[0].rolcanlogin) throw Object.assign(new Error(), { code: 'UNEXPECTED_ROLE_PRIVILEGES' })
      }
      step = app.id + ':membership'
      await client.query(`GRANT ${qi(app.deployer)} TO CURRENT_USER WITH SET TRUE, INHERIT TRUE`)
      step = app.id + ':database'
      const dbOwner = await client.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [app.database])
      if (!dbOwner.rowCount) await client.query(`CREATE DATABASE ${qi(app.database)} OWNER ${qi(app.deployer)}`)
      else if (dbOwner.rows[0].owner !== app.deployer) throw Object.assign(new Error(), { code: 'UNEXPECTED_DATABASE_OWNER' })
      step = app.id + ':database-access'
      await client.query(`SET ROLE ${qi(app.deployer)}`)
      await client.query(`REVOKE ALL ON DATABASE ${qi(app.database)} FROM PUBLIC`)
      // CAP usa tabelas temporárias para transmitir parâmetros de INSERT.
      await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${qi(app.database)} TO ${qi(app.deployer)}, ${qi(app.runtime)}`)
      await client.query('RESET ROLE')
      step = app.id + ':schema'
      const db = new Client({ ...config(app.database), user: app.deployer, password: app.deployerPassword })
      try {
        await db.connect()
        await db.query(`SET ROLE ${qi(app.deployer)}`)
        await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
        await db.query(`CREATE SCHEMA IF NOT EXISTS ${qi(app.schema)} AUTHORIZATION ${qi(app.deployer)}`)
        await db.query(`GRANT USAGE ON SCHEMA ${qi(app.schema)} TO ${qi(app.runtime)}`)
        await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(app.deployer)} IN SCHEMA ${qi(app.schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qi(app.runtime)}`)
        await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(app.deployer)} IN SCHEMA ${qi(app.schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${qi(app.runtime)}`)
        console.log('CAP_PG_BOOTSTRAP ' + JSON.stringify({ app: app.id, databaseCreated: true, separateRuntime: true }))
      } finally { await db.end().catch(() => {}) }
    }
  } finally { await client.end().catch(() => {}) }
}
main().catch(error => {
  let message = error.message || ''
  for (const secret of [admin?.password, ...(plan?.apps || []).flatMap(app => [app.deployerPassword, app.runtimePassword])]) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]')
  }
  console.log('CAP_PG_BOOTSTRAP ' + JSON.stringify({ ok: false, step, errorCode: error.code || 'BOOTSTRAP_FAILED', message }))
  process.exitCode = 1
})
