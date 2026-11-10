"""Provision/migrate secrets inside CF; local state contains metadata only.

Uses one temporary Credential Store binding (trial supports 3 total). Runtime APIs
use the other two. No service-key or app environment is fetched to the workstation.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid
from cloud_context import load, save_private

ROOT = Path(__file__).resolve().parents[1]
STORE = 'cap-lab-credentials'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['setup', 'migrate', 'provision', 'rotate', 'check', 'isolation', 'deploy-model', 'cleanup'])
    parser.add_argument('--app', choices=['requests', 'assets'])
    args = parser.parse_args()
    ctx = load()
    source = ctx.cf_source()
    if args.mode == 'deploy-model' and not args.app:
        parser.error('--app is required for deploy-model')
    with tempfile.TemporaryDirectory(prefix='cap-secrets-') as tmp:
        cfg = Path(tmp) / '.cf'
        cfg.mkdir(mode=0o700)
        shutil.copyfile(source, cfg / 'config.json')
        os.chmod(cfg / 'config.json', 0o600)
        env = dict(os.environ, CF_HOME=tmp)
        def cf(*parts, timeout=180, check=True):
            result = subprocess.run(['cf', *parts], env=env, capture_output=True, text=True, timeout=timeout)
            if check and result.returncode:
                raise RuntimeError('CF operation failed: ' + parts[0] + '; sensitive output omitted.')
            return result
        def service(name):
            result = cf('service', name, '--guid', check=False)
            return result.stdout.strip() if result.returncode == 0 else ''
        if args.mode == 'setup':
            if not service(STORE):
                cf('create-service', 'credstore', 'trial', STORE, '-c', '{"authentication":{"type":"mtls"}}')
            for _ in range(36):
                result = cf('service', STORE).stdout
                if 'create succeeded' in result or 'update succeeded' in result:
                    print('Credential Store ready: trial / mTLS.'); return
                if 'failed' in result:
                    raise RuntimeError('Credential Store provisioning failed.')
                time.sleep(5)
            raise RuntimeError('Credential Store provisioning pending; rerun setup.')
        if args.mode == 'cleanup':
            state = json.loads(ctx.state.read_text())
            ctx.validate_state(state)
            if state.get('stage') != 'validated' or state.get('assets_stage') != 'validated':
                raise RuntimeError('Validate both API deliveries before removing legacy credentials.')
            if not state.get('secrets_rotated'):
                raise RuntimeError('Rotate and validate the SQL credentials before removing the legacy checkpoint.')
            # Fail before removal if either running API still has an old DB binding.
            for app in ['requests', 'assets']:
                app_id = cf('app', 'cap-lab-' + app, '--guid').stdout.strip()
                rows = json.loads(cf('curl', '/v3/service_credential_bindings?app_guids=' + app_id).stdout)['resources']
                ids = {r['relationships']['service_instance']['data']['guid'] for r in rows}
                if service('cap-lab-' + app + '-runtime-db') in ids:
                    raise RuntimeError('Old runtime binding still attached; deploy and validate both APIs first.')
                if service(STORE) not in ids:
                    raise RuntimeError('API missing Credential Store binding.')
            for app in ['requests', 'assets']:
                for role in ['runtime', 'deploy']:
                    name = f'cap-lab-{app}-{role}-db'
                    if service(name): cf('delete-service', name, '-f')
            if ctx.state.exists():
                # Read the old state only in process memory. Never log its contents.
                state = json.loads(ctx.state.read_text())
                ctx.validate_state(state)
                safe = {key: state[key] for key in ['stage','assets_stage','target','db_runtime_validated','pair_isolation_validated','approuter_stage','secrets_rotated'] if key in state}
                safe['credential_backend'] = 'credstore'
                save_private(ctx.state, safe)
            print('Legacy UPS services removed; local checkpoint reduced to non-secret metadata.')
            return
        if args.mode == 'rotate' and ctx.state.exists():
            state = json.loads(ctx.state.read_text())
            ctx.validate_state(state)
            state['secrets_rotated'] = False
            save_private(ctx.state, state)
        namespaces = {}
        services = []
        command = 'node secrets.cjs ' + args.mode
        folder = ROOT / 'tools' / 'inspect-db'
        if args.mode in ['migrate', 'provision', 'rotate']:
            services.append(ctx.postgres_service)
            for app in ['requests','assets']:
                for role in ['runtime','deployer']:
                    namespaces[f'cap-lab-{app}-{role}'] = ['read','create','update']
                    if args.mode == 'migrate': services.append(f'cap-lab-{app}-' + ('deploy' if role == 'deployer' else role) + '-db')
        elif args.mode in ['check','isolation']:
            namespaces = {f'cap-lab-{app}-runtime': ['read'] for app in ['requests','assets']}
            if args.mode == 'isolation': command = 'node secrets.cjs check && node isolation-pair.cjs'
        else:
            namespaces = {f'cap-lab-{args.app}-deployer':['read']}
            folder = ROOT / 'apps' / args.app / 'gen' / 'pg'
            command = 'npm start'
        services.append(dict(name=STORE, parameters=dict(authorization=dict(default_permissions=[], namespace_permissions=namespaces))))
        name = 'cap-secret-task-' + uuid.uuid4().hex[:8]
        spec = dict(name=name, memory='256M', disk_quota='512M', **{'no-route':True}, buildpacks=['nodejs_buildpack'], services=services,
                    env={'LAB_POSTGRES_SERVICE':ctx.postgres_service, 'NODE_ENV':'production'})
        if args.mode == 'deploy-model':
            spec['env'].update(CAP_LAB_DOMAIN=args.app, CAP_LAB_DB_ROLE='deployer', cds_requires_db_kind='postgres')
        # JSON is valid YAML and avoids another local dependency.
        manifest = Path(tmp) / 'task.yml'
        manifest.write_text(json.dumps(dict(applications=[spec])))
        try:
            print('Publishing temporary task: ' + args.mode, flush=True)
            cf('push', name, '--task', '-p', str(folder), '-f', str(manifest), timeout=480)
            result = cf('run-task', name, '--command', command, '--name', args.mode, '-m', '256M', '--wait', timeout=300, check=False)
            logs = cf('logs', name, '--recent').stdout
            prefixes = ('CAP_SECRETS ', 'CAP_PAIR_ISOLATION ')
            for line in logs.splitlines():
                for prefix in prefixes:
                    if prefix in line: print(line[line.index(prefix):], flush=True)
            if result.returncode: raise RuntimeError('Cloud task failed; inspect sanitized task markers. Task: ' + name)
            print('Task completed: ' + args.mode, flush=True)
            if args.mode == 'rotate' and ctx.state.exists():
                state = json.loads(ctx.state.read_text())
                ctx.validate_state(state)
                state['secrets_rotated'] = True
                save_private(ctx.state, state)
            if args.mode == 'provision':
                if not ctx.state.exists(): save_private(ctx.state,dict(target=ctx.target,stage='bindings-created',credential_backend='credstore'))
        finally:
            result = cf('delete', name, '-f', check=False)
            if result.returncode: print('Cleanup required for temporary app: ' + name)


if __name__ == '__main__':
    main()
