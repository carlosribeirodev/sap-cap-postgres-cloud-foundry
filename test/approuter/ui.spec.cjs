const { test, expect } = require('@playwright/test');
const id = '9f099aa5-f3e1-4ceb-904f-dddabc13e45e';
async function fixture(page, { editor = true, denied = false, expired = false, denyWrite = false } = {}) {
  let rows = [{ ID: id, title: 'Preparar ambiente de estudos', description: 'Revisar o acesso ao laboratório.', status: 'OPEN', createdAt: '2026-11-09T12:00:00Z' }];
  const writes = [];
  await page.route('**/user-api/currentUser', route => route.fulfill({ json: { displayName: 'Pessoa de Teste', scopes: [editor ? 'app.RequestsEditor' : 'app.RequestsViewer'] } }));
  await page.route('**/odata/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (expired) return route.fulfill({ status: 401, body: '' });
    if (url.pathname.endsWith('/requests/')) {
      expect(req.headers()['x-csrf-token']).toBe('Fetch');
      return route.fulfill({ headers: { 'x-csrf-token': 'synthetic-csrf' }, json: {} });
    }
    if (req.method() === 'GET') return denied ? route.fulfill({ status: 403, body: '' }) : route.fulfill({ json: { value: rows, '@odata.count': rows.length } });
    expect(req.headers()['x-csrf-token']).toBe('synthetic-csrf');
    expect(req.headers()['x-requested-with']).toBe('XMLHttpRequest');
    writes.push(req.method());
    if (denyWrite) return route.fulfill({ status: 403, body: '' });
    if (req.method() === 'POST') {
      const created = { ...req.postDataJSON(), ID: 'ed908cb0-df3b-4226-819b-39046285cd97', createdAt: '2026-11-09T13:00:00Z' };
      rows.unshift(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (req.method() === 'PATCH') {
      rows[0].status = req.postDataJSON().status;
      return route.fulfill({ json: rows[0] });
    }
    if (req.method() === 'DELETE') { rows.shift(); return route.fulfill({ status: 204, body: '' }); }
    throw new Error('Unexpected request');
  });
  return writes;
}
test('editor cria, atualiza e exclui com CSRF', async ({ page }) => {
  const writes = await fixture(page);
  await page.goto('/');
  await expect(page.getByText('Perfil de edição')).toBeVisible();
  await page.getByLabel('Título obrigatório').fill('<img src=x onerror=alert(1)>');
  await page.getByLabel('Descrição opcional').fill('Solicitação sintética');
  await page.getByRole('button', { name: 'Criar solicitação' }).click();
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  await page.getByRole('combobox').first().selectOption('DONE');
  await expect(page.getByRole('combobox').first()).toHaveValue('DONE');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Excluir <img src=x onerror=alert(1)>' }).click();
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toHaveCount(0);
  expect(writes).toEqual(['POST', 'PATCH', 'DELETE']);
});
test('consulta não oferece controles de escrita', async ({ page }) => {
  await fixture(page, { editor: false });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Preparar ambiente de estudos' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar solicitação' })).toBeHidden();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Excluir/ })).toHaveCount(0);
});
test('403 preserva o formulário e mostra a recusa do backend', async ({ page }) => {
  await fixture(page, { denyWrite: true });
  await page.goto('/');
  await page.getByLabel('Título obrigatório').fill('Solicitação não autorizada');
  await page.getByRole('button', { name: 'Criar solicitação' }).click();
  await expect(page.getByRole('status')).toContainText('não tem permissão');
  await expect(page.getByLabel('Título obrigatório')).toHaveValue('Solicitação não autorizada');
});
test('sessão expirada oferece novo login', async ({ page }) => {
  await fixture(page, { expired: true });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Sua sessão expirou');
  await expect(page.getByRole('link', { name: 'Entrar novamente' })).toBeVisible();
});
test('interface cabe em desktop e celular', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Preparar ambiente de estudos' })).toBeVisible();
  await page.screenshot({ path: '/tmp/cap-requests-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/cap-requests-mobile.png', fullPage: true });
});
