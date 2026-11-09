# Validation record

Reference environment tested on **2026-11-09**. This is an educational lab, not a
production-readiness certification. Account IDs, live instance URLs, credentials
and private operational inventory are intentionally excluded from this repository.

## Reference environment

- SAP BTP CF: PostgreSQL managed service (`postgresql-db`, `trial`) and XSUAA
  (`application`). Availability/cost must be confirmed in the reader's account.
- PostgreSQL 16.13; TLS with certificate validation.
- CF runtime Node.js 24.22.1, npm 11.19.1, nodejs_buildpack 1.9.6, cflinuxfs4.
- CAP 10.2.2, CDS DK 10.2.1, compiler 7.2.1, PostgreSQL adapter 3.1.2,
  xssec 4.16.0 and AppRouter 23.4.0.

Two logical databases with private schemas and deployment/runtime logins were
created on the same existing instance. Requests and Assets now each have their own
CAP API and AppRouter. Tables/views for each were created by the CAP deployer with
its domain-specific deployment login; the managed PostgreSQL instance was reused.

## Observed results

| Test | Evidence |
| --- | --- |
| Runtime SQL CRUD | Passed; synthetic changes rolled back. |
| Runtime administrative privileges | CREATEDB, CREATEROLE and SUPERUSER absent. |
| Runtime persistent table creation | Denied with SQLSTATE 42501. |
| Requests runtime connecting to Assets database | Denied with SQLSTATE 42501. |
| Assets runtime connecting to Requests database | Denied with SQLSTATE 42501. |
| Runtime bindings share host/port | Passed, with distinct databases/schemas/users. |
| CRUD and persistent DDL restriction for both domains | Passed independently. |
| CAP mock viewer using the real PostgreSQL database | Read 200; writes/deletes 403. |
| CAP mock editor using the real PostgreSQL database | Create/read/update/delete passed; createdBy recorded the mock identity. |
| Anonymous production API request | HTTP 401. |
| Real XSUAA technical token without business scope | HTTP 403. |
| Production health | HTTP 200. |
| AppRouter login initiation | HTTPS OAuth authorization URL, exact callback, code flow and browser state verified. |
| AppRouter API/User API AJAX without session | HTTP 401. |
| Public logout page and stylesheet | HTTP 200. |

Temporary diagnostic/bootstrap/deployment/SQL-smoke applications and service keys
were removed after the original cloud validation. The existing database, separate
logical databases, technical connection services and XSUAA were preserved.

## Browser UI tests

Eleven Playwright tests ran with synthetic API/identity fixtures in isolated Chrome:
five for Requests and six for Assets. They cover create/edit/delete with CSRF and
escaped content, read-only controls, app-specific role presentation, form retention
after 403, expired sessions, edit cancellation and mobile layout. Screenshots were
inspected. These tests neither sign in to BTP nor write to its database.

## Publication portability changes

The public version replaces account-specific constants with an ignored local
configuration and generated manifests. Target-bound private state and configuration
rendering are covered by offline Python tests. These helpers do not provision a
fresh CF account during testing. The complete portable flow must still be rehearsed
in each new target. The initial Requests deployment predates this generalization;
the Assets deployment and bidirectional SQL tests used the portable configuration.

## Limits

- A person's complete browser login, role assignment and UI CRUD must be confirmed
  by that person in the recording/reproduction rehearsal. Do not infer it from mock
  role tests or OAuth redirect checks.
- Local Compose was not run in the original automation session because Docker daemon
  access was unavailable. The local commands and prerequisites are documented, but
  that path is not claimed to have been executed there.
- Local builds ran under Node.js 25.9.0 and emitted dependency engine warnings.
  Use Node.js 24 for reproduction; the cloud runtime used Node.js 24.
- Destructive model migrations, multi-tenancy, HA, backup/restore,
  automatic password rotation and a production delivery pipeline are outside scope.
- Trial expiration, quotas, service permissions and commercial costs are
  account/region/plan dependent.

## Complete two-application example

`cloud-assets.py` used the existing Assets database and UPS credentials, updated the
shared XSUAA with Assets-specific scopes/role collections, deployed the Assets CDS
model and published its API and AppRouter. No second PostgreSQL managed instance
was created and database bootstrap was not rerun.

The real CF task `isolation-pair.cjs` received only the two runtime bindings:

```json
{"sameInstanceEndpoint":true,"separateDatabases":true,"separateSchemas":true,"separateUsers":true}
{"app":"requests","ownDatabaseAndSchema":true,"crud":true,"persistentDDLBlocked":true,"crossDatabaseDenied":true}
{"app":"assets","ownDatabaseAndSchema":true,"crud":true,"persistentDDLBlocked":true,"crossDatabaseDenied":true}
```

Each cross-database attempt specifically expected SQLSTATE 42501. Network failures
would not count as passing. SQL writes were rolled back; the Assets CAP HTTP smoke
created, updated and removed its own synthetic record with mock identities against
the real database. It also checked viewer restrictions and managed user fields.

The production APIs both returned health 200, anonymous data 401 and real XSUAA
technical-token-without-business-scope 403. Assets AppRouter verified the exact
OAuth callback/state, AJAX-without-session 401 and public logout/stylesheet 200.
Requests AppRouter was rechecked after the shared XSUAA update. Temporary deployer,
isolation task app and XSUAA test key were removed; persistent apps/services/data
were retained. The state checkpoint records `assets_stage=validated`.

A person's session still needs the matching role collection: **CAP Lab Assets
Editor/Viewer** is separate from **CAP Lab Requests Editor/Viewer**. Complete human
browser login/CRUD is a manual rehearsal step, not inferred from these tests.
