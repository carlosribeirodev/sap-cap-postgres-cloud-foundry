"""Shared, account-independent configuration for Cloud Foundry helpers.

Reading/rendering configuration never deploys resources. Runtime passwords belong
to the ignored .local directory, not configuration examples or tracked manifests.
"""
import json
import os
from pathlib import Path
import re
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def save_private(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Context:
    def __init__(self, path=None):
        path = Path(path or os.environ.get('CAP_LAB_CONFIG', ROOT / 'cloud' / 'lab.json'))
        if not path.exists():
            raise RuntimeError('Copy cloud/lab.example.json to cloud/lab.json and configure your own account first.')
        self.config = json.loads(path.read_text())
        for key in ['org', 'space', 'domain', 'route_suffix', 'postgres_service']:
            value = self.config.get(key)
            if not isinstance(value, str) or not value.strip() or 'YOUR_' in value or '\n' in value:
                raise RuntimeError('Configure a real value for: ' + key)
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', self.config['route_suffix']):
            raise RuntimeError('route_suffix must be a lowercase DNS label.')
        if not re.fullmatch(r'[a-z0-9.-]+', self.config['domain']):
            raise RuntimeError('domain must be a DNS name without protocol, port or path.')
        if not re.fullmatch(r'[A-Za-z0-9_-]+', self.config['postgres_service']):
            raise RuntimeError('postgres_service contains unsupported characters.')
        self.postgres_service = self.config['postgres_service']
        self.api_url = 'https://cap-lab-requests-' + self.config['route_suffix'] + '.' + self.config['domain']
        self.ui_url = 'https://cap-lab-requests-ui-' + self.config['route_suffix'] + '.' + self.config['domain']
        self.state = Path(self.config.get('state_file', ROOT / '.local' / 'cloud-state.json')).expanduser()
        if not self.state.is_absolute():
            self.state = ROOT / self.state
        self.state = self.state.resolve()
        # Configurable locations are private: prevent placing secret state in source folders.
        if self.state.is_relative_to(ROOT) and not self.state.is_relative_to(ROOT / '.local'):
            raise RuntimeError('State inside the repository must be under ignored .local/.')
        self.target = {key: self.config[key] for key in ['org', 'space', 'postgres_service']}

    def cf_source(self):
        source = Path(os.environ.get('CF_HOME', str(Path.home()))) / '.cf' / 'config.json'
        config = json.loads(source.read_text())
        if config.get('OrganizationFields', {}).get('Name') != self.config['org'] or config.get('SpaceFields', {}).get('Name') != self.config['space']:
            raise RuntimeError('CF target does not match cloud/lab.json. Check cf target before continuing.')
        return source

    def validate_state(self, state):
        if state.get('target') != self.target:
            raise RuntimeError('State belongs to another/unrecorded target. Verify it before any deployment; do not delete passwords to bypass this check.')

    def render(self, relative, output=None):
        template = ROOT / relative
        text = template.read_text()
        for key, value in self.config.items():
            if isinstance(value, str):
                text = text.replace('((' + key + '))', value)
        unresolved = set(re.findall(r'\(\(([a-z_]+)\)\)', text)) - {'app_name'}
        if unresolved:
            raise RuntimeError('Unresolved template variables: ' + ', '.join(sorted(unresolved)))
        # Generated manifests live elsewhere, so resolve application paths against the template.
        text = re.sub(r'(?m)^(\s*path:\s*)([^\n]+)$', lambda m: m[1] + json.dumps(str((template.parent / m[2].strip()).resolve())), text)
        folder = ROOT / '.local' / 'generated'
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        result = folder / (output or template.name)
        result.write_text(text)
        return result


def load():
    return Context()
