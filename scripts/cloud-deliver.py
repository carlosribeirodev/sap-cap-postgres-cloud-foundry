"""Entrega a primeira API CAP e executa validações sem exibir bindings."""
import json
import base64
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
import sys
from cloud_context import load, save_private

ROOT = Path(__file__).resolve().parents[1]


def main():
    context = load()
    STATE = context.state
    state = json.loads(STATE.read_text())
    context.validate_state(state)
    if state['stage'] not in ['bindings-created', 'xsuaa-created', 'model-deployed', 'api-deployed', 'validated']:
        raise RuntimeError('Preparação do banco ainda não concluída.')
    source = context.cf_source()
    manifests = {name: context.render('cloud/' + name) for name in ['xs-security.json', 'deployer.yml', 'requests.yml']}
    def save():
        save_private(STATE, state)
    if '--redeploy-model' in sys.argv and state['stage'] in ['model-deployed', 'api-deployed', 'validated']:
        state['stage'] = 'xsuaa-created'
        state['db_runtime_validated'] = False
        save()
    if '--redeploy-api' in sys.argv and state['stage'] in ['api-deployed', 'validated']:
        state['stage'] = 'model-deployed'
        save()
    with tempfile.TemporaryDirectory(prefix='cap-cloud-deliver-') as tmp:
        cfg = Path(tmp) / '.cf'
        cfg.mkdir(mode=0o700)
        shutil.copyfile(source, cfg / 'config.json')
        os.chmod(cfg / 'config.json', 0o600)
        env = dict(os.environ, CF_HOME=tmp)
        def cf(*args, timeout=90, check=True):
            r = subprocess.run(['cf', *args], env=env, capture_output=True, text=True, timeout=timeout)
            if check and r.returncode:
                raise RuntimeError('Falha em cf ' + args[0] + '; consultar logs sem exibir credenciais.')
            return r
        if state['stage'] == 'bindings-created':
            print('Criando XSUAA no plano application.', flush=True)
            cf('create-service', 'xsuaa', 'application', 'cap-lab-requests-auth', '-c', str(manifests['xs-security.json']))
            state['stage'] = 'xsuaa-created'
            save()
        for _ in range(24):
            r = cf('service', 'cap-lab-requests-auth')
            if 'create succeeded' in r.stdout or 'update succeeded' in r.stdout:
                break
            if 'create failed' in r.stdout or 'update failed' in r.stdout:
                raise RuntimeError('Falha ao provisionar XSUAA.')
            time.sleep(5)
        else:
            raise RuntimeError('XSUAA ainda em provisionamento.')
        if state['stage'] == 'xsuaa-created':
            print('Preparando deployer CAP sem rota pública.', flush=True)
            try:
                cf('push', 'cap-lab-requests-deployer', '--task', '-f', str(manifests['deployer.yml']), timeout=420)
                task = cf('run-task', 'cap-lab-requests-deployer', '--command', 'node grant-runtime.cjs && npm start', '--name', 'deploy-cds-model', '-m', '256M', '--wait', timeout=180, check=False)
                if task.returncode:
                    raise RuntimeError('Task de deploy do modelo falhou; sem iniciar API.')
                state['stage'] = 'model-deployed'
                save()
                print('Modelo CDS implantado pelo deployer CAP.', flush=True)
            finally:
                cf('delete', 'cap-lab-requests-deployer', '-f', check=False)
        if state['stage'] == 'model-deployed':
            print('Publicando API com binding de runtime e XSUAA.', flush=True)
            cf('push', 'cap-lab-requests', '-f', str(manifests['requests.yml']), timeout=420)
            state['stage'] = 'api-deployed'
            save()
        if state['stage'] in ['api-deployed', 'validated'] and not state.get('db_runtime_validated'):
            app = 'cap-pg-smoke-' + uuid.uuid4().hex[:8]
            tool = ROOT / 'tools' / 'inspect-db'
            # Manifest próprio: o teste não recebe o binding administrativo mypgsql.
            manifest = Path(tmp) / 'smoke.yml'
            manifest.write_text('applications:\n  - name: ' + app + '\n    memory: 128M\n    disk_quota: 512M\n    no-route: true\n    buildpacks: [nodejs_buildpack]\n    services: [cap-lab-requests-runtime-db]\n')
            try:
                print('Validando CRUD e restrições com a credencial de runtime.', flush=True)
                cf('push', app, '--task', '-f', str(manifest), '-p', str(tool), timeout=420)
                task = cf('run-task', app, '--command', 'node smoke.cjs', '--name', 'runtime-isolation', '-m', '128M', '--wait', timeout=150, check=False)
                logs = cf('logs', app, '--recent')
                markers = [line[line.index('CAP_PG_SMOKE '):] for line in logs.stdout.splitlines() if 'CAP_PG_SMOKE ' in line]
                print('\n'.join(markers), flush=True)
                if task.returncode or not any('"crossDatabaseDenied":true' in line for line in markers):
                    raise RuntimeError('Validação de runtime/isolation falhou.')
            finally:
                cf('delete', app, '-f', check=False)
            state['db_runtime_validated'] = True
            save()
        if state['stage'] in ['api-deployed', 'validated']:
            base = context.api_url
            print('Testando regras de autorização CAP com identidades simuladas e banco real.', flush=True)
            auth_task = cf('run-task', 'cap-lab-requests', '--command', 'NODE_ENV=development node smoke-auth.cjs', '--name', 'cap-authorization', '-m', '256M', '--wait', timeout=150, check=False)
            logs = cf('logs', 'cap-lab-requests', '--recent')
            auth_markers = [line[line.index('CAP_AUTH_SMOKE '):] for line in logs.stdout.splitlines() if 'CAP_AUTH_SMOKE ' in line]
            print('\n'.join(auth_markers), flush=True)
            if auth_task.returncode or not any('"editorCRUD":true' in line for line in auth_markers):
                raise RuntimeError('Teste das regras de autorização CAP falhou.')
            for path, expected in [('/health', 200), ('/odata/v4/requests/Requests', 401)]:
                try:
                    with urllib.request.urlopen(base + path, timeout=30) as response:
                        status = response.status
                except urllib.error.HTTPError as error:
                    status = error.code
                if status != expected:
                    raise RuntimeError('HTTP inesperado: ' + str(status) + ' para ' + path)
                print('HTTP ' + str(status) + ': ' + path, flush=True)
            # Token técnico válido sem scopes de negócio deve ser negado pelo CAP.
            key = 'cap-lab-auth-check-' + uuid.uuid4().hex[:8]
            cf('create-service-key', 'cap-lab-requests-auth', key)
            try:
                result = cf('service-key', 'cap-lab-requests-auth', key)
                raw = json.loads(result.stdout[result.stdout.index('{'):])
                auth = raw.get('credentials', raw)
                basic = base64.b64encode((auth['clientid'] + ':' + auth['clientsecret']).encode()).decode()
                request = urllib.request.Request(auth['url'].rstrip('/') + '/oauth/token',
                    data=urllib.parse.urlencode(dict(grant_type='client_credentials')).encode(),
                    headers={'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    token = json.load(response)['access_token']
                request = urllib.request.Request(base + '/odata/v4/requests/Requests', headers={'Authorization': 'Bearer ' + token})
                try:
                    with urllib.request.urlopen(request, timeout=30) as response:
                        status = response.status
                except urllib.error.HTTPError as error:
                    status = error.code
                if status != 403:
                    raise RuntimeError('Token técnico sem papel de negócio retornou HTTP ' + str(status) + '; esperado 403.')
                print('XSUAA real: token técnico validado; acesso sem scope de negócio recusado com 403.', flush=True)
            finally:
                cf('delete-service-key', 'cap-lab-requests-auth', key, '-f')
                print('Service key de teste XSUAA removida.', flush=True)
            state['stage'] = 'validated'
            save()
            print('API publicada; testes de banco e proteção anônima concluídos.', flush=True)


if __name__ == '__main__':
    main()
