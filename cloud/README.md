# Reproduce the Cloud Foundry deployment

This guide deploys the Requests CAP API and AppRouter to your own BTP CF space,
with two isolated logical databases on an existing PostgreSQL instance. It does
not deploy the Assets cloud API and does not create a PostgreSQL service implicitly.

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
Application paths are made absolute relative to the checked-out repository.
Do not deploy the unresolved templates directly.

Routes are derived as:

```text
API: https://cap-lab-requests-<route_suffix>.<domain>
UI:  https://cap-lab-requests-ui-<route_suffix>.<domain>
```

CF application/service names and SQL names use the `cap-lab-` / `cap_lab_` prefix.
Use a dedicated space and an instance without conflicting lab databases/roles.
A route suffix alone does not namespace these other resources. The bootstrap
refuses existing names on its initial run rather than silently taking ownership.

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

## 5. Prepare isolated databases and technical credentials

```sh
python3 scripts/cloud-bootstrap.py
```

This is a real infrastructure operation. It creates:

- `cap_lab_requests_db` and `cap_lab_assets_db` in the existing server;
- schemas `cap_lab_requests` and `cap_lab_assets`;
- independent deployer/runtime logins for each domain, with random passwords;
- four user-provided services: `cap-lab-{requests,assets}-{deploy,runtime}-db`.

The managed administrator binding is used only by a temporary, route-free task.
The bootstrap prepares access and default grants; it does **not** create business
tables. Runtime logins have CONNECT and TEMPORARY on their database and DML grants
on the application's tables through default privileges. They have no persistent
schema CREATE, CREATEDB, CREATEROLE or SUPERUSER. TEMPORARY is needed by CAP's
PostgreSQL insert buffers. The deployer owns its database/schema.

The managed service can connect with `SESSION_USER` different from `CURRENT_USER`.
The bootstrap grants membership to the effective role with SET/INHERIT enabled,
then uses the application's deployer credentials to configure its schema.

A temporary service key, password-payload service and bootstrap application are
removed in `finally` cleanup. The existing managed PostgreSQL service is preserved.
Password/checkpoint state is written atomically with mode 0600. It is bound to the
configured target. Keep it private and retain it for recovery; deleting it is not a
safe way to rerun provisioning or rotate passwords.

### Recovering an interrupted bootstrap

Read the reported stage without sharing the state contents. If it is
`bootstrap-needs-review`, inspect the created resources first:

```sh
python3 scripts/cloud-bootstrap.py --inspect
```

After reviewing the output and ownership, resume with the preserved passwords:

```sh
python3 scripts/cloud-bootstrap.py --resume
```

Do not use `--resume` to adopt unrelated resources. A different failure stage,
partially created user-provided services, missing state, or an unexpected owner
requires manual review. The helpers are not a general infrastructure reconciliation
engine and do not automatically undo or delete databases after partial progress.
If CF cannot be reached during cleanup, inspect the named temporary app/service/key
and remove only those resources once access is restored.

## 6. Deploy the model, API and validation tasks

```sh
python3 scripts/cloud-deliver.py
```

The helper creates `cap-lab-requests-auth` using XSUAA `application`, stages a
route-free deployer task and runs `cds-deploy`. CAP creates business tables/views.
The deployer application is removed after execution, while its connection service
remains for future deliveries. It then publishes `cap-lab-requests` with 256 MB,
a five-connection pool, the runtime binding and XSUAA.

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
```

This preserves XSUAA, the four technical connection services, PostgreSQL and data.
Review dependencies before removing any of those persistent resources. In
particular, never delete the shared instance as part of an individual application's
cleanup. UPS connections can use it even when no app is directly bound to it.
The API and AppRouter require 512 MB combined, plus staging/tasks. Check plan costs,
quotas and expiration in your own account; no universal zero-cost claim is made.

Passwords in user-provided services are not broker-rotated automatically. Update
PostgreSQL and the matching connection service together, then refresh app bindings
as required. Keep the private state protected and consistent with that change.

## References

- [CAP PostgreSQL](https://cap.cloud.sap/docs/guides/databases/postgres)
- [CAP authorization](https://cap.cloud.sap/docs/guides/security/authorization)
- [AppRouter configuration](https://help.sap.com/docs/btp/sap-business-technology-platform/application-router-configuration)
- [Assign role collections](https://help.sap.com/docs/btp/sap-business-technology-platform/assigning-role-collections-to-users-or-user-groups?locale=en-us)
- [PostgreSQL role attributes](https://www.postgresql.org/docs/16/role-attributes.html)
