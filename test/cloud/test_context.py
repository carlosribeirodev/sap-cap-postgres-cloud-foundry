import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cloud_context', Path(__file__).resolve().parents[2] / 'scripts' / 'cloud_context.py')
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.patch = patch.object(context, 'ROOT', self.root)
        self.patch.start()
        self.config = dict(org='sample-org', space='dev', domain='apps.example.invalid', route_suffix='sample', postgres_service='shared-postgres')
        self.path = self.root / 'config.json'
        self.write()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def write(self):
        self.path.write_text(json.dumps(self.config))

    def test_urls_and_default_private_state(self):
        cfg = context.Context(self.path)
        self.assertEqual(cfg.api_url, 'https://cap-lab-requests-sample.apps.example.invalid')
        self.assertEqual(cfg.assets_api_url, 'https://cap-lab-assets-sample.apps.example.invalid')
        self.assertEqual(cfg.assets_ui_url, 'https://cap-lab-assets-ui-sample.apps.example.invalid')
        self.assertEqual(cfg.state, self.root / '.local' / 'cloud-state.json')

    def test_state_path_cannot_escape_ignored_folder_into_source(self):
        self.config['state_file'] = '.local/../tracked-secret.json'
        self.write()
        with self.assertRaisesRegex(RuntimeError, 'ignored .local'):
            context.Context(self.path)

    def test_target_mismatch_fails_before_mutation(self):
        home = self.root / 'home'
        (home / '.cf').mkdir(parents=True)
        (home / '.cf' / 'config.json').write_text(json.dumps({'OrganizationFields': {'Name': 'another-org'}, 'SpaceFields': {'Name': 'dev'}}))
        with patch.dict(os.environ, {'CF_HOME': str(home)}):
            with self.assertRaisesRegex(RuntimeError, 'target'):
                context.Context(self.path).cf_source()

    def test_checkpoint_is_bound_to_target(self):
        cfg = context.Context(self.path)
        cfg.validate_state({'target': cfg.target})
        with self.assertRaises(RuntimeError):
            cfg.validate_state({'target': {'org': 'another-org'}})

    def test_render_keeps_only_explicit_runtime_placeholder(self):
        source = self.root / 'cloud' / 'app.yml'
        source.parent.mkdir()
        source.write_text('name: ((app_name))\npath: ../apps/requests/gen/srv\nroute: ((route_suffix)).((domain))\n')
        result = context.Context(self.path).render('cloud/app.yml')
        text = result.read_text()
        self.assertIn('name: ((app_name))', text)
        self.assertIn('sample.apps.example.invalid', text)
        self.assertIn(str(self.root / 'apps/requests/gen/srv'), text)
        source.write_text('value: ((unknown_variable))')
        with self.assertRaisesRegex(RuntimeError, 'Unresolved'):
            context.Context(self.path).render('cloud/app.yml')

    def test_atomic_secret_file_is_private(self):
        target = self.root / '.local' / 'state.json'
        context.save_private(target, {'stage': 'prepared'})
        context.save_private(target, {'stage': 'completed'})
        self.assertEqual(json.loads(target.read_text()), {'stage': 'completed'})
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(target.parent.glob('.state-*')), [])

    def test_example_placeholders_are_rejected(self):
        self.config['org'] = 'YOUR_CF_ORG'
        self.write()
        with self.assertRaisesRegex(RuntimeError, 'real value'):
            context.Context(self.path)


    def test_api_and_deployer_namespace_policies_are_separate(self):
        # Assert the checked-in policy boundary rather than the rendering internals.
        project = Path(__file__).resolve().parents[2]
        for app in ['requests', 'assets']:
            for role, filename in [('runtime', app + '.yml'), ('deployer', 'deployer.yml' if app == 'requests' else 'assets-deployer.yml')]:
                text = (project / 'cloud' / filename).read_text()
                self.assertIn('name: cap-lab-credentials', text)
                self.assertIn(f'cap-lab-{app}-{role}: [read]', text)
                self.assertNotIn('vcap_name', text)
                self.assertNotIn('user-provided', text)
                self.assertNotIn('postgres_service', text)
                self.assertNotIn(': [create', text)


if __name__ == '__main__':
    unittest.main()
