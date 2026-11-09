// Compatibilidade com bancos preparados antes da concessão de TEMPORARY.
// Executado pelo dono do banco, nunca pela API.
const { Client } = require(require.resolve('pg', { paths: [require.resolve('@cap-js/postgres')] }))
const bindings = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat()
const c = bindings.find(b => b.name === 'cap-lab-requests-deploy-db')?.credentials
async function main() {
  if (!c || c.database !== 'cap_lab_requests_db' || c.user !== 'cap_lab_requests_deployer') throw new Error('Unexpected binding')
  const client = new Client({ ...c, connectionTimeoutMillis: 10000 })
  try {
    await client.connect()
    await client.query('GRANT TEMPORARY ON DATABASE cap_lab_requests_db TO cap_lab_requests_runtime')
    console.log('CAP_RUNTIME_PRIVILEGES temporaryBuffers=true persistentDDL=false')
  } finally { await client.end().catch(() => {}) }
}
main().catch(error => {
  console.log('CAP_RUNTIME_PRIVILEGES ' + JSON.stringify({ ok: false, errorCode: error.code || 'GRANT_FAILED' }))
  process.exitCode = 1
})
