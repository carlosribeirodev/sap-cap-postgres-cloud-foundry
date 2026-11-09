// Executar somente como task de teste, com NODE_ENV=development.
// Exercita as regras CAP com identidades simuladas e o PostgreSQL real.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const cds = require('@sap/cds')

async function main() {
  assert.equal(process.env.NODE_ENV, 'development')
  await cds.plugins
  assert.equal(cds.env.requires.auth.kind, 'mocked')
  const server = await cds.server({ port: 0 })
  const base = `http://127.0.0.1:${server.address().port}/odata/v4/requests/Requests`
  let id
  async function request(method, user, path = '', body) {
    const headers = { 'Content-Type': 'application/json' }
    if (user) headers.Authorization = 'Basic ' + Buffer.from(user + ':').toString('base64')
    return fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  }
  try {
    assert.equal((await request('GET')).status, 401)
    assert.equal((await request('GET', 'viewer')).status, 200)
    assert.equal((await request('POST', 'viewer', '', { title: 'Sem permissão' })).status, 403)
    const created = await request('POST', 'editor', '', { title: 'Teste CAP ' + randomUUID() })
    assert.equal(created.status, 201)
    const row = await created.json()
    id = row.ID
    assert.equal(row.createdBy, 'editor')
    assert.equal((await request('PATCH', 'editor', `(${id})`, { status: 'DONE' })).status, 200)
    const read = await request('GET', 'viewer', `(${id})`)
    assert.equal(read.status, 200)
    assert.equal((await read.json()).status, 'DONE')
    assert.equal((await request('DELETE', 'viewer', `(${id})`)).status, 403)
    assert.equal((await request('DELETE', 'editor', `(${id})`)).status, 204)
    id = undefined
    console.log('CAP_AUTH_SMOKE ' + JSON.stringify({ anonymousDenied: true, viewerReadOnly: true, editorCRUD: true, managedUser: true, identities: 'mocked' }))
  } finally {
    if (id) await request('DELETE', 'editor', `(${id})`).catch(() => {})
    await new Promise(resolve => server.close(resolve))
    await cds.db?.disconnect()
  }
}
main().catch(error => {
  console.log('CAP_AUTH_SMOKE ' + JSON.stringify({ ok: false, errorCode: error.code || 'ASSERTION_FAILED' }))
  process.exitCode = 1
})
