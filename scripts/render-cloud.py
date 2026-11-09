"""Render Cloud Foundry templates locally; no cloud requests or mutations."""
from cloud_context import load

if __name__ == '__main__':
    context = load()
    for filename in ['requests.yml', 'deployer.yml', 'approuter.yml', 'xs-security.json']:
        context.render('cloud/' + filename)
    context.render('tools/inspect-db/manifest.yml', 'inspect-db.yml')
    print('Configuration rendered under .local/generated/. No cloud resources changed.')
