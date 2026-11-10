# Reproduce the Cloud Foundry deployment

This guide deploys two CAP APIs and their AppRouters to your own BTP CF space,
using two isolated logical databases on one existing PostgreSQL instance. It does
not create a PostgreSQL managed service implicitly.

## 1. Check account capabilities and sign in

You need CF CLI v8, Node.js 24, npm, Python 3.10+, a CF org/space and Space Developer
access. An account administrator is needed to assign role collections to users.
Check current regional availability, entitlements, plan parameters and quotas.

```sh
cf login --sso
cf target
cf marketplace -e postgresql-db
cf marketplace -e xsuaa
cf services
cf domains
```

Use the API endpoint displayed in your BTP cockpit if the CLI is not yet targeted.
Select the intended org/space before proceeding. XSUAA needs the `application`
plan. PostgreSQL needs a bindable existing `postgresql-db` instance with TLS and
permissions to create databases/roles/schemas. If there is no instance, provision
one through your account's approved service plan and parameters before continuing.
A plan named `trial` is not assumed to be available everywhere or equivalent to a
commercial plan. Temporary tasks also consume staging and execution quotas.

## 2. Configure your target

```sh
cp cloud/lab.example.json cloud/lab.json
```

Edit the ignored `cloud/lab.json`:

| Setting | Meaning |
| --- | --- |
| `org` | Exact CF organization name matching the active CLI target. |
| `space` | Exact CF space name. |
| `domain` | A shared application domain listed by `cf domains`, without protocol. |
| `route_suffix` | A unique lowercase DNS label to avoid route/xsappname conflicts. |
| `postgres_service` | Name of your existing PostgreSQL service instance. |

Optional `state_file` can select another private checkpoint location. The default
is `.local/cloud-state.json`. Inside the repository, state must remain under ignored
`.local/`. `CAP_LAB_CONFIG` can select another configuration file.

```sh
python3 scripts/render-cloud.py
```

This only generates `.local/generated/requests.yml`, `deployer.yml`,
`approuter.yml`, `xs-security.json` and `inspect-db.yml`. It makes no cloud calls.
Assets manifests are also rendered: `assets.yml`, `assets-deployer.yml` and
`assets-approuter.yml`. Application paths are made absolute relative to the checked-out repository.
Do not deploy the unresolved templates directly.

Routes are derived as:

```text
API: https://cap-lab-requests-<route_suffix>.<domain>
UI:  https://cap-lab-requests-ui-<route_suffix>.<domain>
```

CF application/service names and SQL names use the `cap-lab-` / `cap_lab_` prefix.
Use a dedicated space and an instance without conflicting lab databases/roles.
A route suffix alone does not namespace these other resources. The provisioner rejects existing SQL users without corresponding stored credentials
rather than silently taking ownership.

## 3. Optional database diagnosis

The diagnostic task runs inside CF because the database may not be reachable from
your workstation. Using only the managed instance binding, it reports capabilities
without dumping credentials. The output is metadata, not proof that every DDL
operation or managed-service policy will succeed.

```sh
cf push cap-pg-inspector --task --no-route -p tools/inspect-db -f .local/generated/inspect-db.yml --var app_name=cap-pg-inspector
cf run-task cap-pg-inspector --command 'node inspect.cjs' --name inspect-permissions -m 128M --wait
cf logs cap-pg-inspector --recent
cf delete cap-pg-inspector -f
```

Use a free temporary app name. Inspect the `CAP_PG_INSPECTION` line; never print
`VCAP_SERVICES`, service keys or `cf env` while recording/sharing diagnostics.
Do not weaken TLS verification to bypass a connection failure.

## 4. Build the first CAP application

```sh
npm ci
npm run build:requests
node scripts/prepare-cloud.mjs
npm --prefix apps/requests/gen/pg install --package-lock-only --ignore-scripts --no-audit --no-fund
npm --prefix apps/requests/gen/srv install --package-lock-only --ignore-scripts --no-audit --no-fund
```

`gen/pg` contains the PostgreSQL deployer and compiled model. `gen/srv` contains
the backend. `prepare-cloud.mjs` pins deployer dependencies/Node.js and includes the
smoke helpers. Rebuilding overwrites generated output: repeat preparation/lockfile
steps after each build. Build does not create cloud tables.

## 5. Provision isolated databases and stored credentials

```sh
python3 scripts/cloud-secrets.py setup
python3 scripts/cloud-secrets.py provision
```

`setup` creates `cap-lab-credentials` using the available `credstore` trial plan
and mTLS authentication. This is an explicit free trial resource, subject to your
account's quota/expiration. Check `cf marketplace -e credstore` first.

`provision` publishes a temporary task with the managed PostgreSQL binding and
Credential Store access to four namespaces. The task generates passwords inside
CF, stores them before SQL changes, then creates the two databases/schemas and
runtime/deployer SQL users. An advisory lock prevents concurrent provisioners;
existing owners and role privileges are checked. A pending stored password can
be reapplied after interruption. Unexpected pre-existing users without stored
credentials are rejected: they are not adopted or assigned a new password.

Namespaces are `cap-lab-{requests,assets}-{runtime,deployer}`; each contains a
binary/key credential named `postgres` with format `json`, whose base64 value
contains the connection JSON (including its TLS CA chain). A password entry is
limited to 4,096 characters and cannot hold this connection bundle; a key entry
supports up to 32 KB. The
trial plan permits three bindings, ten namespaces and ten credentials. Two bindings
belong to the APIs; only one temporary provisioning/deployer/test task may use the
remaining binding at a time. Rate limiting is handled with bounded retries.

The task applies restricted SQL grants and default privileges, including TEMPORARY
for CAP insert buffers. The deployer owns its database/schema; runtime has no
persistent CREATE, CREATEDB, CREATEROLE or SUPERUSER. Business tables are created
later by the CAP deployer. Provisioning still exists, but the old local bootstrap,
temporary password UPS and service-key extraction are no longer used.

SQL passwords are not written to local checkpoints. The local delivery state holds
only target/phase metadata; the authoritative credentials remain in Credential
Store. Protect access to its bindings and to the provisioning identity.

### Credential Store migration and rotation

For an existing deployment from the previous UPS-based version, build and prepare
**both** apps first. Preserve the old services until the migration is validated:

```sh
python3 scripts/cloud-secrets.py setup
python3 scripts/cloud-secrets.py migrate
python3 scripts/cloud-deliver.py --redeploy-api
python3 scripts/cloud-assets.py --redeploy
python3 scripts/cloud-secrets.py check
python3 scripts/cloud-secrets.py isolation
```

Migration reads the four old UPS connections only inside CF, verifies them and
stores them without changing the passwords. Each API is then switched to its
read-only runtime namespace, and its old SQL UPS binding/env selectors are removed.
The check task verifies SQL connections and denies deployer-secret reads; isolation
checks CRUD, blocked persistent DDL and cross-database denial in both directions.

After both APIs work, rotate the old passwords **inside CF**, then restart the APIs
so their pools use the new credentials. Plan for a maintenance window: this lab
uses one login per role and does not implement overlapping password rotation.

```sh
python3 scripts/cloud-secrets.py rotate
cf restart cap-lab-requests
cf restart cap-lab-assets
python3 scripts/cloud-secrets.py check
python3 scripts/cloud-secrets.py isolation
python3 scripts/cloud-secrets.py cleanup
```

Cleanup refuses APIs still bound to old runtime services, deletes the four named
legacy UPS services, and replaces the old local secret checkpoint with selected
non-secret metadata. Old password copies become invalid after rotation; this does
not claim secure erasure of filesystem backups or other previously made copies.
Do not delete the PostgreSQL instance, databases, Credential Store or its credentials.

Credential Store stores credentials; it does not automatically create SQL users or
synchronize SQL password rotation. Its binding credentials also expire and need
renewal/rebinding separately. The apps hold SQL credentials only in process memory;
`VCAP_SERVICES` contains the mTLS Credential Store access, not the database password.
`lib/cloud-start.cjs` fetches and validates the connection before CAP starts, keeps
TLS validation enabled, and fails closed if the secret is unavailable or pending.

Developers with production Space Developer, binding access, SSH/task execution or
unreviewed release powers may still extract/use secrets. A production deployment
needs controlled automation identities, access restrictions, review and auditing.

## 6. Deploy the model, API and validation tasks

```sh
python3 scripts/cloud-deliver.py
```

The helper creates `cap-lab-requests-auth` using XSUAA `application`, stages a
route-free deployer task and runs the CAP deploy API. CAP creates business tables/views.
The deployer application is removed after execution, while its credential remains in Credential Store for future deliveries. It then publishes `cap-lab-requests` with 256 MB,
a five-connection pool, read-only runtime namespace access and XSUAA.

It checks SQL CRUD/isolation, mocked CAP roles with the real database, HTTP health,
anonymous 401 and real XSUAA client-credentials token rejection with 403 when no
business scope is granted. Temporary test apps and keys are removed. A partially
completed delivery retains its stage for recovery rather than starting over.

For an API-only republication after rebuilding and preparing artifacts:

```sh
python3 scripts/cloud-deliver.py --redeploy-api
```

This does not redeploy a changed CDS database model. Model evolution is a separate
operation: stage `.local/generated/deployer.yml`, run its deployer task, inspect the
result, remove the task app, then republish the API. Automatic CAP schema evolution
has limits; do not assume destructive changes are supported or safe.

## 7. Publish browser login and the UI

```sh
npm --prefix apps/approuter ci
python3 scripts/cloud-approuter.py
```

The script updates XSUAA with the complete rendered descriptor, including exact
login/logout callback URLs, then publishes `cap-lab-requests-ui` with 256 MB.
It binds only to the existing XSUAA, not to a SQL service. A destination forwards
the token to the API. AppRouter handles session cookies and CSRF protection.

The initial login response can be HTML 200 containing a JavaScript redirect to
preserve fragments. Browser-style requests include OAuth state protection. The
checker accepts this SAP behavior and verifies the authorization URL/callback;
it does not complete a human's identity-provider login.

To recheck routing without updating or republishing:

```sh
python3 scripts/cloud-approuter.py --check-only
```

## 8. Assign a person's access and verify the complete flow

In the subaccount cockpit, open **Security → Role Collections**, edit
**CAP Lab Requests Editor** (or **CAP Lab Requests Viewer**) and add your own user
with the correct identity provider. Save, then start a fresh browser session.
The deployment does not assign access to a person.

Open the rendered UI URL, authenticate and verify:

1. Editor can create a synthetic request, read it, change status and delete it.
2. Viewer can read and cannot perform writes. Use a separate correctly configured
   user/session; do not present the mock tests as a real viewer's browser login.
3. Refresh preserves records while the browser session remains valid.
4. Logout ends the application session; the UI offers login again.
5. API requests made outside the UI still require a valid token and business scope.

The interface is plain HTML/CSS/JavaScript. Controls adapt to token scopes returned
by AppRouter's User API, but CAP remains the authorization boundary. No password
user table is involved. XSUAA login and SQL technical accounts solve different needs.

## 9. Complete the second application: Assets

The initial provisioning already prepared `cap_lab_assets_db`, its private schema
and deployer/runtime credentials in Credential Store. Do not run it again to deploy this API.

```sh
npm run build:assets
node scripts/prepare-cloud.mjs assets
npm --prefix apps/assets/gen/pg install --package-lock-only --ignore-scripts --no-audit --no-fund
npm --prefix apps/assets/gen/srv install --package-lock-only --ignore-scripts --no-audit --no-fund
npm --prefix apps/assets-approuter ci
python3 scripts/cloud-assets.py
```

The helper updates the shared XSUAA descriptor with Assets scopes, role collections
and callback URLs while retaining Requests definitions. It stages the Assets
model deployer using only its deployer namespace, creates tables through CAP,
and publishes `cap-lab-assets` with only its runtime namespace and XSUAA.
The API never receives the Requests SQL binding.

It then checks Assets CAP authorization with mock identities and the real database.
A temporary route-free task receives the two **runtime** connection services to
validate the shared host/port, distinct database/schema/users, own-domain CRUD,
blocked persistent DDL and SQLSTATE 42501 for cross-database connections in both
directions. Changes made by SQL tests roll back. No administrative binding is used.

`cap-lab-assets-ui` provides an independent browser entry point with name and serial
number fields, editing and deletion. Role collections are **CAP Lab Assets Viewer**
and **CAP Lab Assets Editor**. Assign them separately in the cockpit with the correct
identity provider, then start a fresh session. Requests role assignments are retained
and do not automatically authorize Assets.

```text
Assets API: https://cap-lab-assets-<route_suffix>.<domain>/odata/v4/assets/Assets
Assets UI:  https://cap-lab-assets-ui-<route_suffix>.<domain>/
```

Checkpoint `assets_stage` is kept in the same ignored, target-bound state file.
After a failure, inspect the stage/resources and rerun the helper to resume.
After rebuilding code, `python3 scripts/cloud-assets.py --redeploy` intentionally
reapplies the Assets model/API/UI and reruns its validations. It does not provision
new databases or replace passwords. If a task fails, keep the checkpoint and remove
only any specifically reported temporary resources after review.

To recheck Assets browser routing without publishing:

```sh
python3 scripts/cloud-approuter.py --assets --check-only
```

The original AppRouter helper defaults to Requests. Its `--assets` option selects
the Assets manifest, route and OData path. Both use the same XSUAA instance but
separate AppRouter sessions and business-role scopes. Human login and CRUD in each
browser session remain a separate manual recording/reproduction check.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| CLI authentication expired | Renew `cf login --sso`, select the target and retry the appropriate stage. |
| Target mismatch | Compare `cf target` with `cloud/lab.json`; do not remove the guard. |
| Direct SQL connection times out | Use the route-free CF diagnosis task; the service may be network-restricted. |
| Cannot SET ROLE/create a database | Inspect effective role/membership and plan capabilities. Do not give runtime administrative privileges. |
| Certificate error | Check the binding's CA/hostname; keep certificate validation enabled. |
| Local password change has no effect | Initialization only runs on an empty volume; rotate SQL passwords explicitly or reset only disposable local data. |
| Browser login succeeds but API returns 403 | Assign the correct role collection/IdP and start a fresh session. |
| API returns 401 | Check session/token, XSUAA binding and whether the client is using the UI or the raw API URL. |
| OData path returns 404 | Use `/odata/v4/requests`; a leading slash in CDS `@path` creates an absolute route. |
| UI write returns CSRF error | Obtain a token with `X-CSRF-Token: Fetch` and submit in the same session. Do not disable protection. |
| XSUAA remains pending/failed | Inspect the service operation, entitlement, xsappname uniqueness and quota before retrying. |

## Cleanup, lifecycle and cost

Remove only the application and its route when that is the intended cleanup:

```sh
cf delete cap-lab-requests-ui -r -f
cf delete cap-lab-requests -r -f
cf delete cap-lab-assets-ui -r -f
cf delete cap-lab-assets -r -f
```

This preserves XSUAA, Credential Store, PostgreSQL and data.
Review dependencies before removing any of those persistent resources. In
particular, never delete the shared instance as part of an individual application's
cleanup. Stored connections can use it even when no app is directly bound to it.
The two APIs and two AppRouters require 1 GB combined, plus staging/tasks. Check plan costs,
quotas and expiration in your own account; no universal zero-cost claim is made.

Credential Store does not broker-rotate custom SQL logins automatically. Use the
explicit rotation task and restart APIs afterwards. Renew expiring Credential Store
bindings separately; never use a broad managed database binding as a runtime fallback.

## References

- [SAP Credential Store](https://help.sap.com/docs/credential-store/sap-credential-store)
- [Credential Store least privilege](https://help.sap.com/docs/credential-store/sap-credential-store/principle-of-least-privilege)
- [CAP PostgreSQL](https://cap.cloud.sap/docs/guides/databases/postgres)
- [CAP authorization](https://cap.cloud.sap/docs/guides/security/authorization)
- [AppRouter configuration](https://help.sap.com/docs/btp/sap-business-technology-platform/application-router-configuration)
- [Assign role collections](https://help.sap.com/docs/btp/sap-business-technology-platform/assigning-role-collections-to-users-or-user-groups?locale=en-us)
- [PostgreSQL role attributes](https://www.postgresql.org/docs/16/role-attributes.html)
