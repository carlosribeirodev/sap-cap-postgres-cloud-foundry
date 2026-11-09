import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const app = process.argv[2] || 'requests'
if (!['requests', 'assets'].includes(app)) throw new Error('Expected requests or assets')
const pgPackage = new URL(`apps/${app}/gen/pg/package.json`, root)
const spec = JSON.parse(readFileSync(pgPackage))
spec.engines = { node: '24.x' }
spec.dependencies = { '@sap/cds': '10.2.2', '@cap-js/postgres': '3.1.2' }
writeFileSync(pgPackage, JSON.stringify(spec, null, 2) + '\n')
copyFileSync(new URL(`apps/${app}/smoke-auth.cjs`, root), new URL(`apps/${app}/gen/srv/smoke-auth.cjs`, root))
copyFileSync(new URL('scripts/grant-runtime.cjs', root), new URL(`apps/${app}/gen/pg/grant-runtime.cjs`, root))
console.log('Artefatos de cloud preparados; gerar os lockfiles de gen/pg e gen/srv antes de publicar.')
