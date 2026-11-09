"""Publica AppRouter sem acessar sessões pessoais ou imprimir tokens."""
import json
import html
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from cloud_context import load

ROOT = Path(__file__).resolve().parents[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    context = load()
    source = context.cf_source()
    assets = '--assets' in sys.argv
    app_name = 'cap-lab-assets-ui' if assets else 'cap-lab-requests-ui'
    base = context.assets_ui_url if assets else context.ui_url
    entity_path = '/odata/v4/assets/Assets' if assets else '/odata/v4/requests/Requests'
    security = context.render('cloud/xs-security.json')
    manifest = context.render('cloud/assets-approuter.yml' if assets else 'cloud/approuter.yml')
    with tempfile.TemporaryDirectory(prefix='cap-approuter-') as tmp:
        cfg = Path(tmp) / '.cf'
        cfg.mkdir(mode=0o700)
        shutil.copyfile(source, cfg / 'config.json')
        os.chmod(cfg / 'config.json', 0o600)
        env = dict(os.environ, CF_HOME=tmp)
        def cf(*args, timeout=90):
            r = subprocess.run(['cf', *args], env=env, capture_output=True, text=True, timeout=timeout)
            if r.returncode:
                raise RuntimeError('Falha em cf ' + args[0] + '; saída omitida para preservar credenciais.')
            return r
        if '--check-only' not in sys.argv and '--skip-xsuaa-update' not in sys.argv:
            print('Atualizando os callbacks autorizados no XSUAA existente.', flush=True)
            cf('update-service', 'cap-lab-requests-auth', '-c', str(security))
            for _ in range(24):
                r = cf('service', 'cap-lab-requests-auth')
                if 'update succeeded' in r.stdout:
                    break
                if 'update failed' in r.stdout:
                    raise RuntimeError('Atualização do XSUAA falhou.')
                time.sleep(5)
            else:
                raise RuntimeError('Atualização do XSUAA ainda em andamento.')
        if '--check-only' not in sys.argv:
            print('Publicando AppRouter: ' + app_name, flush=True)
            cf('push', app_name, '-f', str(manifest), timeout=420)
        opener = urllib.request.build_opener(NoRedirect())
        def get(url, ajax=False):
            headers = {'User-Agent': 'Mozilla/5.0 (CAP Lab validation)'}
            headers.update({'X-Requested-With': 'XMLHttpRequest'} if ajax else {'Accept': 'text/html'})
            try:
                return opener.open(urllib.request.Request(url, headers=headers), timeout=30)
            except urllib.error.HTTPError as error:
                return error
        url = base + '/'
        for _ in range(5):
            with get(url) as response:
                if response.status == 200:
                    # O AppRouter preserva fragments com um redirect JavaScript.
                    body = response.read().decode()
                    match = re.search(r'location="(https://[^"<>]+)"', body)
                    if not match or 'Suas solicitações' in body:
                        raise RuntimeError('Página pública inesperada antes do login.')
                    target = html.unescape(match.group(1))
                elif response.status in [301, 302, 303, 307, 308]:
                    target = urllib.parse.urljoin(url, response.headers['Location'])
                else:
                    raise RuntimeError('Login não redirecionou; HTTP ' + str(response.status))
            parsed = urllib.parse.urlparse(target)
            if parsed.netloc == urllib.parse.urlparse(base).netloc:
                url = target
                continue
            query = urllib.parse.parse_qs(parsed.query)
            assert parsed.scheme == 'https'
            assert parsed.path.endswith('/oauth/authorize')
            assert query.get('redirect_uri') == [base + '/login/callback']
            assert query.get('response_type') == ['code']
            assert query.get('state')
            print('Login OAuth: redirect HTTPS, callback exato, authorization code e state verificados.', flush=True)
            break
        else:
            raise RuntimeError('Número excessivo de redirecionamentos de login.')
        for path, ajax, expected in [(entity_path, True, 401), ('/user-api/currentUser', True, 401), ('/logout.html', False, 200), ('/styles.css', False, 200)]:
            with get(base + path, ajax) as response:
                if response.status != expected:
                    raise RuntimeError('HTTP inesperado em ' + path + ': ' + str(response.status))
                print('HTTP ' + str(response.status) + ': ' + path, flush=True)
        print('AppRouter publicado; login real e role collection devem ser confirmados pela pessoa no navegador.', flush=True)


if __name__ == '__main__':
    main()
