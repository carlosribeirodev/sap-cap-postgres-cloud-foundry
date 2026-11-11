# Temporary PostgreSQL tasks

These helpers are staged inside Cloud Foundry with no public route. They do not
need direct workstation access to a network-restricted PostgreSQL service.

These tasks belong to the standalone CAP recipe. The catalog project has its own
provisioning and verification worker. Read the
[integration boundary](../../docs/infrastructure-catalog.md) before running these
helpers against an existing environment; their names and vault namespaces differ.

Configure `cloud/lab.json` and run `python3 scripts/render-cloud.py` first. Use the
rendered `.local/generated/inspect-db.yml` and a temporary application name. See
[the cloud guide](../../cloud/README.md) for the complete command sequence.

- `inspect.cjs` reads capability metadata in a read-only transaction. It prints no
  binding/URI/password or user identity values.
- `secrets.cjs` provisions SQL resources or migrates/rotates credentials inside CF.
  It uses the managed PostgreSQL binding only for those infrastructure operations,
  stores passwords in Credential Store and prints only sanitized status markers.
  Invoke through `scripts/cloud-secrets.py`; it replaces the old local bootstrap.
- `smoke.cjs` uses only the Requests runtime namespace to check SQL CRUD, lack of
  persistent DDL privileges and denied cross-database access. Test writes roll back.
- `isolation-pair.cjs` reads both runtime namespaces in a temporary test task,
  confirms a common host/port with distinct users/databases/schemas, and checks
  own-domain CRUD, blocked persistent DDL and cross-database denial in both directions.
  It never receives the managed administrator binding; SQL changes roll back.

The manifest selects the configured managed service through `LAB_POSTGRES_SERVICE`.
TLS validation remains enabled. The API never receives that administrator-capable
managed binding. Always remove temporary apps/bindings/keys after diagnosis;
never delete the shared PostgreSQL service as part of a single app's cleanup.
