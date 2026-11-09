# Temporary PostgreSQL tasks

These helpers are staged inside Cloud Foundry with no public route. They do not
need direct workstation access to a network-restricted PostgreSQL service.

Configure `cloud/lab.json` and run `python3 scripts/render-cloud.py` first. Use the
rendered `.local/generated/inspect-db.yml` and a temporary application name. See
[the cloud guide](../../cloud/README.md) for the complete command sequence.

- `inspect.cjs` reads capability metadata in a read-only transaction. It prints no
  binding/URI/password or user identity values.
- `bootstrap.cjs` is an infrastructure-changing helper invoked by
  `scripts/cloud-bootstrap.py`. It uses a temporary password-payload binding and
  never creates business tables. Do not execute it as an ad hoc read-only check.
- `smoke.cjs` uses only the Requests runtime binding to check SQL CRUD, lack of
  persistent DDL privileges and denied cross-database access. Test writes roll back.
- `isolation-pair.cjs` receives both runtime bindings in a temporary test task,
  confirms a common host/port with distinct users/databases/schemas, and checks
  own-domain CRUD, blocked persistent DDL and cross-database denial in both directions.
  It never receives the managed administrator binding; SQL changes roll back.

The manifest selects the configured managed service through `LAB_POSTGRES_SERVICE`.
TLS validation remains enabled. The API never receives that administrator-capable
managed binding. Always remove temporary apps/bindings/keys after diagnosis;
never delete the shared PostgreSQL service as part of a single app's cleanup.
