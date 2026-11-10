const { test } = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync } = require('node:crypto')
const { seal, unseal, connection, createStore } = require('../../lib/credential-store.cjs')
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding:{ type:'spki', format:'pem' }, privateKeyEncoding:{type:'pkcs8',format:'pem'} })
test('encrypted payload round-trip and authenticated tamper rejection', () => {
 const secret={name:'postgres',value:'test-password'}
 const encrypted=seal(secret,publicKey)
 assert(!encrypted.includes(secret.value))
 assert.deepEqual(unseal(encrypted,privateKey),secret)
 const pieces=encrypted.split('.')
 const tag=Buffer.from(pieces[4],'base64url');tag[0]^=1;pieces[4]=tag.toString('base64url')
 assert.throws(()=>unseal(pieces.join('.'),privateKey))
})
const valid={host:'db.example.invalid',port:5432,database:'cap_lab_requests_db',schema:'cap_lab_requests',user:'cap_lab_requests_runtime',password:'unit-test-only',ssl:{ca:'test-ca',rejectUnauthorized:true}}
test('connection resolves only its namespace and preserves TLS verification',async()=>{
 let called
 const c=await connection('requests','runtime',{read:async ns=>{called=ns;return{value:Buffer.from(JSON.stringify(valid)).toString('base64')}}})
 assert.equal(called,'cap-lab-requests-runtime');assert.deepEqual(c,valid)
})
test('missing, mismatched, pending or invalid TLS secrets fail closed',async()=>{
 for(const entry of [null,{...valid,user:'cap_lab_assets_runtime'},{...valid,phase:'prepared'},{...valid,ssl:{rejectUnauthorized:false}}]) {
  await assert.rejects(connection('requests','runtime',{read:async()=>entry?{value:Buffer.from(JSON.stringify(entry)).toString('base64')}:null}))
 }
 await assert.rejects(connection('requests','admin',{read:async()=>{throw new Error('Must not read')}}))
})
test('missing secure binding fails without echoing credentials',()=>{
 assert.throws(()=>createStore({password:'must-not-appear'}),e=>!e.message.includes('must-not-appear'))
})
