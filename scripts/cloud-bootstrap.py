"""Provisiona somente recursos nominados do laboratório no destino verificado.

Segredos ficam fora do projeto, em local/credentials, com modo 0600.
Não imprimir stdout de service-key, conteúdo de bindings ou exceções com credenciais.
"""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import uuid
import sys
from cloud_context import load, save_private

ROOT = Path(__file__).resolve().parents[1]


def main():
    context = load()
    source = context.cf_source()
    STATE = context.state
    SECRET_DIR = STATE.parent
    SECRET_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = 'inspect' if '--inspect' in sys.argv else 'resume' if '--resume' in sys.argv else 'create'
    if STATE.exists() and mode == 'create':
        raise RuntimeError('Estado privado já existe. Inspecione o progresso antes de retomar; não sobrescrever senhas.')
    if mode != 'create':
        state = json.loads(STATE.read_text())
        context.validate_state(state)
        if state['stage'] != 'bootstrap-needs-review':
            raise RuntimeError('Estado não permite retomar bootstrap.')
        apps = state['apps']
    else:
        apps = []
        for app in ['requests', 'assets']:
            apps.append(dict(id=app, database=f'cap_lab_{app}_db', schema=f'cap_lab_{app}',
                         deployer=f'cap_lab_{app}_deployer', runtime=f'cap_lab_{app}_runtime',
                         deployerPassword=secrets.token_hex(24), runtimePassword=secrets.token_hex(24)))
        state = dict(apps=apps, stage='prepared', target=context.target)
    def save():
        save_private(STATE, state)
    save()
    with tempfile.TemporaryDirectory(prefix='cap-cloud-bootstrap-') as tmp:
        tmp = Path(tmp)
        cfg = tmp / '.cf'
        cfg.mkdir(mode=0o700)
        shutil.copyfile(source, cfg / 'config.json')
        os.chmod(cfg / 'config.json', 0o600)
        env = dict(os.environ, CF_HOME=str(tmp))
        def cf(*args, timeout=90, check=True):
            r = subprocess.run(['cf', *args], env=env, capture_output=True, text=True, timeout=timeout)
            if check and r.returncode:
                # Só nomes de comando no erro: argumentos podem conter caminhos privados.
                raise RuntimeError('Falha no comando cf ' + args[0] + '; saída sensível omitida.')
            return r
        def private_json(name, value):
            file = tmp / name
            fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump(value, f)
            return str(file)
        tool_manifest = context.render('tools/inspect-db/manifest.yml', 'inspect-db.yml')
        app_name = 'cap-pg-bootstrap-' + uuid.uuid4().hex[:8]
        key_name = 'cap-lab-bootstrap-' + uuid.uuid4().hex[:8]
        key_created = False
        input_created = False
        try:
            cf('create-service-key', context.postgres_service, key_name)
            key_created = True
            r = cf('service-key', context.postgres_service, key_name)
            raw = json.loads(r.stdout[r.stdout.index('{'):])
            admin = raw.get('credentials', raw)
            # Persistir apenas conexão dos usuários próprios; nunca o administrador.
            base = dict(host=admin.get('hostname') or admin.get('host'), port=int(admin.get('port') or 5432),
                        ssl=dict(ca=admin['sslrootcert'], rejectUnauthorized=True))
            for spec in apps:
                spec['runtimeCredentials'] = dict(base, user=spec['runtime'], password=spec['runtimePassword'], database=spec['database'], schema=spec['schema'])
                spec['deployCredentials'] = dict(base, user=spec['deployer'], password=spec['deployerPassword'], database=spec['database'], schema=spec['schema'])
            save()
            cf('create-user-provided-service', 'cap-lab-bootstrap-input', '-p', private_json('bootstrap.json', dict(apps=apps, mode=mode)))
            input_created = True
            tool_path = ROOT / 'tools' / 'inspect-db'
            cf('push', app_name, '--no-start', '--no-route', '-p', str(tool_path), '-f', str(tool_manifest), '--var', 'app_name=' + app_name, timeout=180)
            cf('bind-service', app_name, 'cap-lab-bootstrap-input')
            print('Preparando task de bootstrap sem rota pública.', flush=True)
            cf('push', app_name, '--task', '--no-route', '-p', str(tool_path), '-f', str(tool_manifest), '--var', 'app_name=' + app_name, timeout=420)
            task = cf('run-task', app_name, '--command', 'node bootstrap.cjs', '--name', 'bootstrap-databases', '-m', '128M', '--wait', timeout=150, check=False)
            logs = cf('logs', app_name, '--recent')
            markers = [line[line.index('CAP_PG_BOOTSTRAP '):] for line in logs.stdout.splitlines() if 'CAP_PG_BOOTSTRAP ' in line]
            print('\n'.join(markers), flush=True)
            if mode == 'inspect':
                if task.returncode:
                    raise RuntimeError('Diagnóstico de progresso falhou.')
                return
            if task.returncode or not any('"databaseCreated":true' in line for line in markers):
                state['stage'] = 'bootstrap-needs-review'
                save()
                raise RuntimeError('Bootstrap não concluído; estado e senhas preservados na área privada.')
            state['stage'] = 'databases-created'
            save()
            for spec in apps:
                for kind, field in [('runtime', 'runtimeCredentials'), ('deploy', 'deployCredentials')]:
                    service = f'cap-lab-{spec["id"]}-{kind}-db'
                    cf('create-user-provided-service', service, '-p', private_json(service + '.json', spec[field]))
                    print('Binding técnico preparado: ' + service, flush=True)
            state['stage'] = 'bindings-created'
            save()
        finally:
            # Remover apenas os recursos efêmeros criados por esta execução.
            r = cf('delete', app_name, '-f', check=False)
            print('Aplicação de bootstrap removida.' if r.returncode == 0 else 'Verificar limpeza: ' + app_name, flush=True)
            if input_created:
                r = cf('delete-service', 'cap-lab-bootstrap-input', '-f', check=False)
                print('Payload temporário removido.' if r.returncode == 0 else 'Verificar limpeza do payload temporário.', flush=True)
            if key_created:
                r = cf('delete-service-key', context.postgres_service, key_name, '-f', check=False)
                print('Service key administrativa removida.' if r.returncode == 0 else 'Verificar limpeza: ' + key_name, flush=True)


if __name__ == '__main__':
    main()
