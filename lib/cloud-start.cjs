// Fetch PostgreSQL credentials into process memory, never into VCAP_SERVICES.
async function configure() {
  if (!process.env.CAP_LAB_DOMAIN) return // Local development keeps its own connection.
  const c = await require('./credential-store.cjs').connection()
  const cds = require('@sap/cds')
  cds.env.requires.db.credentials = c
}
async function main() {
  await configure()
  const cds = require('@sap/cds')
  if (process.env.CAP_LAB_DB_ROLE === 'deployer') {
    await cds.plugins
    cds.db = await cds.connect.to('db')
    try { await cds.deploy('*').to(cds.db) } finally { await cds.db.disconnect() }
  } else {
    await require('@sap/cds/bin/serve')(['all'])
  }
}
if (require.main === module) main().catch(() => { console.error('CAP_START_FAILED: configuration, secret access or database unavailable'); process.exitCode = 1 })
module.exports = { configure }
