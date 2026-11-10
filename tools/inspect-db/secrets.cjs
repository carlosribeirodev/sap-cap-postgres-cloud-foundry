// Runs only as a temporary CF task. No credential files, service keys or secret logs.
const { Client } = require('pg')
const { createStore, connection } = require('./credential-store.cjs')
const { randomBytes } = require('node:crypto')
const bindings = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat()
const qi = s => '"' + s.replaceAll('"', '""') + '"'
const ql = s => "'" + s.replaceAll("'", "''") + "'"
const ids = ['requests', 'assets'], roles = ['deployer', 'runtime']
const store = createStore()
const mode = process.argv[2]
let step = 'start'
const print = result => console.log('CAP_SECRETS ' + JSON.stringify(result))
const client = c => new Client({ ...c, connectionTimeoutMillis: 10000, query_timeout: 15000 })
async function verify(c) { const db=client(c); try { await db.connect(); await db.query('SELECT 1') } finally { await db.end().catch(()=>{}) } }
async function main() {
  if (!['migrate', 'provision', 'rotate', 'check'].includes(mode)) throw new Error('Mode required')
  if(mode === 'check') {
    for(const app of ids) {
      const c = await connection(app, 'runtime', store)
      await verify(c)
      try { await store.read(`cap-lab-${app}-deployer`); throw new Error('Unexpected deployer access') } catch(e) { if(e.status !== 403) throw e }
      print({ app, runtimeConnection: true, deployerSecretDenied: true })
    }
    return
  }
  const admin = bindings.find(b=>b.name===process.env.LAB_POSTGRES_SERVICE)?.credentials
  if(!admin) throw new Error('Managed PostgreSQL binding required')
  const base = { host: admin.hostname || admin.host, port: Number(admin.port || 5432), ssl: { ca: admin.sslrootcert, rejectUnauthorized: true } }
  const db=client({ ...base, user:admin.username||admin.user, password:admin.password, database:admin.dbname||admin.database })
  step='connect-managed'; await db.connect()
  try {
    const lock=await db.query("SELECT pg_try_advisory_lock(741029381) AS acquired")
    if(!lock.rows[0].acquired) throw new Error('Provisioning already running')
    for(const app of ids) {
      const database=`cap_lab_${app}_db`, schema=`cap_lab_${app}`, deployer=`cap_lab_${app}_deployer`, runtime=`cap_lab_${app}_runtime`
      let rejectedPrevious = 0
      for(const role of roles) {
        const namespace=`cap-lab-${app}-${role}`, user=`cap_lab_${app}_${role}`
        step=app+':'+role+':read-store'
        let record=await store.read(namespace)
        const existing=await db.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1',[user])
        if(existing.rowCount && (existing.rows[0].rolsuper || existing.rows[0].rolcreatedb || existing.rows[0].rolcreaterole || !existing.rows[0].rolcanlogin)) throw new Error('Unexpected SQL role privileges')
        let c=record && JSON.parse(Buffer.from(record.value, 'base64').toString('utf8'))
        if(c && (c.user!==user || c.database!==database || c.schema!==schema || c.host!==base.host || Number(c.port)!==base.port)) throw new Error('Credential target mismatch')
        if(!c && mode==='migrate') {
          const source=bindings.find(b=>b.name===`cap-lab-${app}-${role==='deployer'?'deploy':'runtime'}-db`)?.credentials
          if(!existing.rowCount || !source || source.user!==user || source.database!==database || source.schema!==schema || source.host!==base.host) throw new Error('Legacy connection not found')
          step=app+':'+role+':verify-legacy'; await verify(source)
          c=source
          step=app+':'+role+':write-store'; await store.write(namespace,{name:'postgres',username:user,format:'json',value:Buffer.from(JSON.stringify(c)).toString('base64')})
        } else if(!c) {
          if(existing.rowCount || mode==='rotate') throw new Error('Existing role without a stored credential; use migration')
          c={...base,database,schema,user,password:randomBytes(32).toString('hex'),phase:'prepared'}
          step=app+':'+role+':write-store'; await store.write(namespace,{name:'postgres',username:user,format:'json',value:Buffer.from(JSON.stringify(c)).toString('base64')})
        }
        let previous
        // Rotation is resumable: persist pending value before SQL and mark ready afterwards.
        if(mode==='rotate' && c.phase!=='prepared') {
          await verify(c)
          previous={...c}
          c={...c,password:randomBytes(32).toString('hex'),phase:'prepared'}
          step=app+':'+role+':write-store'; await store.write(namespace,{name:'postgres',username:user,format:'json',value:Buffer.from(JSON.stringify(c)).toString('base64')})
        }
        if(c.phase==='prepared') {
          if(existing.rowCount) await db.query(`ALTER ROLE ${qi(user)} PASSWORD ${ql(c.password)}`)
          else await db.query(`CREATE ROLE ${qi(user)} LOGIN PASSWORD ${ql(c.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE`)
          const { phase, ...ready }=c
          c=ready
          step=app+':'+role+':write-store'; await store.write(namespace,{name:'postgres',username:user,format:'json',value:Buffer.from(JSON.stringify(c)).toString('base64')})
        }
        if(previous) {
          const old=client(previous)
          try {
            try {await old.connect(); throw new Error('Old password still accepted')}
            catch(error) {if(error.code!=='28P01') throw error; rejectedPrevious++}
          } finally {await old.end().catch(()=>{})}
        }
      }
      step=app+':database-permissions'
      await db.query(`GRANT ${qi(deployer)} TO CURRENT_USER WITH SET TRUE, INHERIT TRUE`)
      const exists=await db.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[database])
      if(!exists.rowCount) await db.query(`CREATE DATABASE ${qi(database)} OWNER ${qi(deployer)}`)
      else if(exists.rows[0].owner!==deployer) throw new Error('Unexpected database owner')
      await db.query(`SET ROLE ${qi(deployer)}`)
      try {
        await db.query(`REVOKE ALL ON DATABASE ${qi(database)} FROM PUBLIC`)
        await db.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${qi(database)} TO ${qi(runtime)}, ${qi(deployer)}`)
      } finally { await db.query('RESET ROLE') }
      const owner=client(await connection(app,'deployer',store))
      try {
        await owner.connect()
        await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
        const schemaOwner=await owner.query('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1',[schema])
        if(schemaOwner.rowCount && schemaOwner.rows[0].owner!==deployer) throw new Error('Unexpected schema owner')
        await owner.query(`CREATE SCHEMA IF NOT EXISTS ${qi(schema)} AUTHORIZATION ${qi(deployer)}`)
        await owner.query(`GRANT USAGE ON SCHEMA ${qi(schema)} TO ${qi(runtime)}`)
        await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(deployer)} IN SCHEMA ${qi(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qi(runtime)}`)
        await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(deployer)} IN SCHEMA ${qi(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${qi(runtime)}`)
      } finally {await owner.end().catch(()=>{})}
      for(const role of roles) await verify(await connection(app,role,store))
      print({app,mode,credentialsInStore:true,sqlAccessVerified:true,...(mode==='rotate'?{previousPasswordsRejected:rejectedPrevious===2}: {})})
    }
  } finally {await db.end().catch(()=>{})}
}
main().catch(error=>{print({ok:false,mode,step,errorCode: /^[A-Z0-9_]+$/.test(error.code||'') ? error.code : 'SECRETS_TASK_FAILED', httpStatus:Number(error.status)||undefined});process.exitCode=1})
