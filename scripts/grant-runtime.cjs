// Compatibilidade com bancos preparados antes da concessão de TEMPORARY.
// Executado pelo dono do banco, nunca pela API.
const { Client } = require(require.resolve('pg', { paths: [require.resolve('@cap-js/postgres')] }))
const bindings = Object.values(JSON.parse(process.env.VCAP_SERVICES || '{}')).flat()
const matches = bindings.filter(b => /^cap-lab-(requests|assets)-deploy-db$/.test(b.name))
const binding = matches.length === 1 ? matches[0] : null
const app = binding?.name.match(/^cap-lab-(requests|assets)-deploy-db$/)[1]
const c = binding?.credentials
async function main() {
  if (!c || c.database !== `cap_lab_${app}_db` || c.user !== `cap_lab_${app}_deployer`) throw new Error('Unexpected binding')
  const client = new Client({ ...c, connectionTimeoutMillis: 10000 })
  try {
    await client.connect()
    await client.query(`GRANT TEMPORARY ON DATABASE "cap_lab_${app}_db" TO "cap_lab_${app}_runtime"`)
    console.log('CAP_RUNTIME_PRIVILEGES temporaryBuffers=true persistentDDL=false')
  } finally { await client.end().catch(() => {}) }
}
main().catch(error => {
  console.log('CAP_RUNTIME_PRIVILEGES ' + JSON.stringify({ ok: false, errorCode: error.code || 'GRANT_FAILED' }))
  process.exitCode = 1
})
