import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const app = process.argv[2] || 'requests'
if (!['requests', 'assets'].includes(app)) throw new Error('Expected requests or assets')
const pgPackage = new URL(`apps/${app}/gen/pg/package.json`, root)
const spec = JSON.parse(readFileSync(pgPackage))
spec.engines = { node: '24.x' }
spec.dependencies = { '@sap/cds': '10.2.2', '@cap-js/postgres': '3.1.2' }
spec.scripts.start = 'node cloud-start.cjs'
writeFileSync(pgPackage, JSON.stringify(spec, null, 2) + '\n')
const srvPackage = new URL(`apps/${app}/gen/srv/package.json`, root)
const srvSpec = JSON.parse(readFileSync(srvPackage))
srvSpec.scripts.start = 'node cloud-start.cjs'
writeFileSync(srvPackage, JSON.stringify(srvSpec, null, 2) + '\n')
const smoke = readFileSync(new URL(`apps/${app}/smoke-auth.cjs`, root), 'utf8').replace('../../lib/cloud-start.cjs', './cloud-start.cjs').replace('../../lib/credential-store.cjs', './credential-store.cjs')
writeFileSync(new URL(`apps/${app}/gen/srv/smoke-auth.cjs`, root), smoke)
for (const target of [`apps/${app}/gen/srv`, `apps/${app}/gen/pg`, 'tools/inspect-db']) {
  for (const file of ['credential-store.cjs', 'cloud-start.cjs']) copyFileSync(new URL(`lib/${file}`, root), new URL(`${target}/${file}`, root))
}
console.log('Artefatos de cloud preparados; gerar os lockfiles de gen/pg e gen/srv antes de publicar.')
