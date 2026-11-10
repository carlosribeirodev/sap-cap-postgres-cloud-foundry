"""Publish the second CAP app and verify both PostgreSQL isolation directions.

Uses existing isolated databases and Credential Store namespaces. Never reruns database bootstrap.
No credentials, raw service-key output or environment dumps are printed.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from cloud_context import load, save_private

ROOT = Path(__file__).resolve().parents[1]


def main():
    context = load()
    source = context.cf_source()
    state = json.loads(context.state.read_text())
    context.validate_state(state)
    if state.get('stage') not in ['api-deployed', 'validated']:
        raise RuntimeError('Deploy the first API and prepare both databases before this operation.')
    phase = state.get('assets_stage', 'prepared')
    if '--redeploy' in sys.argv:
        phase = 'prepared'
    if phase not in ['prepared', 'auth-configured', 'model-deployed', 'api-deployed', 'isolation-validated', 'ui-deployed', 'validated']:
        raise RuntimeError('Unknown Assets checkpoint; inspect private state before resuming.')
    if phase == 'validated':
        print('Second app already validated; use --redeploy after rebuilding to deliver changes.')
        return
    def checkpoint(value):
        nonlocal phase
        phase = value
        state['assets_stage'] = value
        save_private(context.state, state)
    manifests = {name: context.render('cloud/' + name) for name in ['xs-security.json', 'assets.yml', 'assets-deployer.yml']}
    with tempfile.TemporaryDirectory(prefix='cap-assets-deliver-') as tmp:
        cfg = Path(tmp) / '.cf'
        cfg.mkdir(mode=0o700)
        shutil.copyfile(source, cfg / 'config.json')
        os.chmod(cfg / 'config.json', 0o600)
        env = dict(os.environ, CF_HOME=tmp)
        def cf(*args, timeout=90, check=True):
            result = subprocess.run(['cf', *args], env=env, capture_output=True, text=True, timeout=timeout)
            if check and result.returncode:
                raise RuntimeError('CF operation failed: ' + args[0] + '; inspect sanitized logs before resuming.')
            return result
        def markers(app, prefix):
            logs = cf('logs', app, '--recent')
            lines = [line[line.index(prefix):] for line in logs.stdout.splitlines() if prefix in line]
            print('\n'.join(lines), flush=True)
            return lines
        if phase == 'prepared':
            print('Adding Assets scopes and callbacks to shared XSUAA; preserving Requests roles.', flush=True)
            cf('update-service', 'cap-lab-requests-auth', '-c', str(manifests['xs-security.json']))
            for _ in range(24):
                status = cf('service', 'cap-lab-requests-auth').stdout
                if 'update succeeded' in status:
                    break
                if 'update failed' in status:
                    raise RuntimeError('XSUAA update failed.')
                time.sleep(5)
            else:
                raise RuntimeError('XSUAA update still pending.')
            checkpoint('auth-configured')
        if phase == 'auth-configured':
            print('Deploying the Assets CDS model with its own technical deployer.', flush=True)
            try:
                cf('push', 'cap-lab-assets-deployer', '--task', '-f', str(manifests['assets-deployer.yml']), timeout=420)
                task = cf('run-task', 'cap-lab-assets-deployer', '--command', 'npm start', '--name', 'deploy-assets-model', '-m', '256M', '--wait', timeout=180, check=False)
                if task.returncode:
                    raise RuntimeError('Assets model deployment failed; API not published.')
                checkpoint('model-deployed')
                print('Assets model created by CAP; database instance preserved.', flush=True)
            finally:
                cleaned = cf('delete', 'cap-lab-assets-deployer', '-f', check=False)
                if cleaned.returncode:
                    print('Cleanup required: cap-lab-assets-deployer', flush=True)
        if phase == 'model-deployed':
            print('Publishing Assets API with its scoped Credential Store binding and XSUAA.', flush=True)
            # Running processes retain their old environment until this push restarts them.
            # New processes get only the scoped Credential Store binding.
            cf('unbind-service', 'cap-lab-assets', 'cap-lab-assets-runtime-db', check=False)
            for obsolete in ['cds_requires_db_vcap_name', 'cds_requires_db_vcap_label']:
                cf('unset-env', 'cap-lab-assets', obsolete, check=False)
            cf('push', 'cap-lab-assets', '-f', str(manifests['assets.yml']), timeout=420)
            checkpoint('api-deployed')
        if phase == 'api-deployed':
            print('Checking Assets CAP roles with mock identities and the real database.', flush=True)
            task = cf('run-task', 'cap-lab-assets', '--command', 'NODE_ENV=development node smoke-auth.cjs', '--name', 'assets-authorization', '-m', '256M', '--wait', timeout=150, check=False)
            lines = markers('cap-lab-assets', 'CAP_AUTH_SMOKE ')
            if task.returncode or not any('"editorCRUD":true' in line for line in lines):
                raise RuntimeError('Assets CAP authorization test failed.')
            app = 'cap-pair-isolation-' + uuid.uuid4().hex[:8]
            manifest = Path(tmp) / 'isolation.yml'
            manifest.write_text('applications:\n  - name: ' + app + '\n    memory: 128M\n    disk_quota: 512M\n    no-route: true\n    buildpacks: [nodejs_buildpack]\n    services:\n      - name: cap-lab-credentials\n        parameters:\n          authorization:\n            default_permissions: []\n            namespace_permissions:\n              cap-lab-requests-runtime: [read]\n              cap-lab-assets-runtime: [read]\n')
            try:
                print('Checking own-database CRUD and cross-database denial in both directions.', flush=True)
                cf('push', app, '--task', '-f', str(manifest), '-p', str(ROOT / 'tools' / 'inspect-db'), timeout=420)
                task = cf('run-task', app, '--command', 'node isolation-pair.cjs', '--name', 'bidirectional-isolation', '-m', '128M', '--wait', timeout=150, check=False)
                lines = markers(app, 'CAP_PAIR_ISOLATION ')
                results = [json.loads(line.split('CAP_PAIR_ISOLATION ', 1)[1]) for line in lines]
                passed = {row.get('app') for row in results if all(row.get(key) for key in ['ownDatabaseAndSchema', 'crud', 'persistentDDLBlocked', 'crossDatabaseDenied'])}
                if task.returncode or passed != {'requests', 'assets'}:
                    raise RuntimeError('Both isolation directions must pass.')
            finally:
                cleaned = cf('delete', app, '-f', check=False)
                if cleaned.returncode:
                    print('Cleanup required: ' + app, flush=True)
            state['pair_isolation_validated'] = True
            checkpoint('isolation-validated')
        if phase == 'isolation-validated':
            print('Publishing the independent Assets browser entry point.', flush=True)
            result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'cloud-approuter.py'), '--assets', '--skip-xsuaa-update'], env=env, timeout=600)
            if result.returncode:
                raise RuntimeError('Assets AppRouter deployment/check failed.')
            checkpoint('ui-deployed')
        if phase == 'ui-deployed':
            key = 'cap-assets-auth-check-' + uuid.uuid4().hex[:8]
            cf('create-service-key', 'cap-lab-requests-auth', key)
            try:
                result = cf('service-key', 'cap-lab-requests-auth', key)
                raw = json.loads(result.stdout[result.stdout.index('{'):])
                auth = raw.get('credentials', raw)
                basic = base64.b64encode((auth['clientid'] + ':' + auth['clientsecret']).encode()).decode()
                request = urllib.request.Request(auth['url'].rstrip('/') + '/oauth/token', data=urllib.parse.urlencode(dict(grant_type='client_credentials')).encode(), headers={'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    token = json.load(response)['access_token']
                for label, base, path in [('requests', context.api_url, '/odata/v4/requests/Requests'), ('assets', context.assets_api_url, '/odata/v4/assets/Assets')]:
                    for endpoint, bearer, expected in [('/health', False, 200), (path, False, 401), (path, True, 403)]:
                        request = urllib.request.Request(base + endpoint, headers={'Authorization': 'Bearer ' + token} if bearer else {})
                        try:
                            with urllib.request.urlopen(request, timeout=30) as response:
                                status = response.status
                        except urllib.error.HTTPError as error:
                            status = error.code
                        if status != expected:
                            raise RuntimeError(label + ': unexpected HTTP ' + str(status))
                        print(label + ': HTTP ' + str(status) + ' ' + endpoint, flush=True)
            finally:
                cf('delete-service-key', 'cap-lab-requests-auth', key, '-f')
                print('Temporary XSUAA test key removed.', flush=True)
            checkpoint('validated')
            print('Two CAP APIs published; both SQL isolation directions validated.', flush=True)


if __name__ == '__main__':
    main()
