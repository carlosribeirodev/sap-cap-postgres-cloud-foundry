# PostgreSQL infrastructure catalog and CAP integration

Requests and Assets are the application examples. The current infrastructure
catalog and provisioner live in the public
[sap-btp-infra repository](https://github.com/carlosribeirodev/sap-btp-infra).
The catalog flow creates an allocation for an app; the CAP deployer applies that
app's CDS model afterwards. These are separate operations.

## Current state

The catalog provisioner has been validated with PostgreSQL and SAP Credential Store.
Its GitHub Actions workflow validates declarations and runs 39 tests without BTP
credentials. Collaborators with Write use clone, a branch in that repository,
push and a pull request. Main requires CI for everyone and CODEOWNER approval
for non-admins. Only repository admins may bypass review when merging a PR,
including their own; this does not bypass CI or allow a direct push.
See the [request guide](https://github.com/carlosribeirodev/sap-btp-infra/blob/main/CONTRIBUTING.md).

The application code and cloud scripts in this repository still implement the
earlier standalone delivery recipe. **They are not yet integrated with the catalog.**
The reference environment's previous APIs, AppRouters and XSUAA were removed for
the rebuild. Earlier validation records describe that previous deployment; they
do not establish that those endpoints are currently running.

## Naming and compatibility

The following Requests example shows why selecting the new service alone does not
connect the existing runtime to its catalog allocation. Assets follows the same
pattern with `assets` in place of `requests`.

| Resource | Standalone application recipe | Catalog allocation in dev |
| --- | --- | --- |
| Logical database | `cap_lab_requests_db` | `cap_lab_dev_requests` |
| Schema | `cap_lab_requests` | `requests` |
| Runtime user | `cap_lab_requests_runtime` | `cap_lab_dev_requests_runtime` |
| Deployer user | `cap_lab_requests_deployer` | `cap_lab_dev_requests_deployer` |
| Runtime vault namespace | `cap-lab-requests-runtime` | `cap-lab-dev-requests-runtime` |
| Deployer vault namespace | `cap-lab-requests-deployer` | `cap-lab-dev-requests-deployer` |
| Credential Store service | `cap-lab-credentials` | `cap-lab-dev-credentials` |

`lib/credential-store.cjs` currently validates the standalone database, schema and
user names. Manifests and delivery/check helpers select the corresponding older
namespaces. They must be adapted together, including scoped bindings and the
credential readiness checks, before an application can use the catalog.

## Operating the two exercises

For a new infrastructure request, follow the catalog repository and let its
operator apply the reviewed catalog. Its `apply` also verifies the allocation.
Merging a PR currently runs CI only; automated delivery and the dedicated CF
identity remain pending.

For the original independent CAP reproduction, use the
[standalone cloud guide](../cloud/README.md) in a separate target without conflicting
lab resources. The local Docker quick start also remains available.

Do not run the standalone `cloud-secrets.py provision` or `rotate`, or its delivery
and cleanup scripts, against resources managed by the catalog. The ownership
records, names and recovery procedures differ. Updating documentation does not
migrate existing SQL resources or application credentials.

## Remaining delivery work

1. Adapt credential resolution, CAP schema configuration and rendered manifests
   to the catalog's names and per-app runtime/deployer namespaces.
2. Adapt model deployment and application delivery without invoking the standalone
   infrastructure provisioner or adopting unrelated resources.
3. Recreate XSUAA and the APIs/AppRouters with explicit target configuration.
4. Validate model deployment, runtime CRUD/isolation, scoped vault access and
   real browser authentication in the rebuilt environment.

No cloud operation is performed by this document or by ordinary documentation
checks. SQL passwords remain in Credential Store and runtime memory.
