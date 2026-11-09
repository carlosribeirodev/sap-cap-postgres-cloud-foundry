const { test, expect } = require('@playwright/test');
async function fixture(page, { editor = true, expired = false, denyWrite = false, wrongAppRole = false } = {}) {
  let rows = [{ ID: '70a8271b-0c41-4059-9f97-534d9a47f7be', name: 'Notebook do laboratório', serialNumber: 'LAB-001', createdAt: '2026-11-09T12:00:00Z' }];
  const writes = [];
  await page.route('**/user-api/currentUser', route => route.fulfill({ json: { displayName: 'Pessoa de Teste', scopes: [wrongAppRole ? 'app.RequestsEditor' : editor ? 'app.AssetsEditor' : 'app.AssetsViewer'] } }));
  await page.route('**/odata/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (expired) return route.fulfill({ status: 401, body: '' });
    if (wrongAppRole) return route.fulfill({ status: 403, body: '' });
    if (path.endsWith('/assets/')) {
      expect(req.headers()['x-csrf-token']).toBe('Fetch');
      return route.fulfill({ headers: { 'x-csrf-token': 'synthetic-assets-csrf' }, json: {} });
    }
    if (req.method() === 'GET') return route.fulfill({ json: { value: rows, '@odata.count': rows.length } });
    expect(req.headers()['x-csrf-token']).toBe('synthetic-assets-csrf');
    writes.push(req.method());
    if (denyWrite) return route.fulfill({ status: 403, body: '' });
    if (req.method() === 'POST') {
      const row = { ...req.postDataJSON(), ID: 'ad715239-b76f-4fa3-8ab5-b51b018b0418' };
      rows.unshift(row); return route.fulfill({ status: 201, json: row });
    }
    const id = path.match(/Assets\(([^)]+)\)/)[1];
    if (req.method() === 'PATCH') {
      const row = rows.find(row => row.ID === id);
      Object.assign(row, req.postDataJSON()); return route.fulfill({ json: row });
    }
    if (req.method() === 'DELETE') {
      rows = rows.filter(row => row.ID !== id); return route.fulfill({ status: 204, body: '' });
    }
    throw new Error('Unexpected request');
  });
  return writes;
}
test('editor cadastra, edita e exclui usando CSRF', async ({ page }) => {
  const writes = await fixture(page);
  await page.goto('/');
  await page.getByLabel('Nome obrigatório').fill('<img src=x onerror=alert(1)>');
  await page.getByLabel('Número de série opcional').fill('TEST-001');
  await page.getByRole('button', { name: 'Cadastrar ativo' }).click();
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Editar <img src=x onerror=alert(1)>' }).click();
  await page.getByLabel('Nome obrigatório').fill('Monitor do laboratório');
  await page.getByLabel('Número de série opcional').fill('TEST-002');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByRole('heading', { name: 'Monitor do laboratório' })).toBeVisible();
  await expect(page.getByText('Número de série: TEST-002')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Excluir Monitor do laboratório' }).click();
  await expect(page.getByRole('heading', { name: 'Monitor do laboratório' })).toHaveCount(0);
  expect(writes).toEqual(['POST', 'PATCH', 'DELETE']);
});
test('viewer não tem controles de escrita', async ({ page }) => {
  await fixture(page, { editor: false }); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Notebook do laboratório' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cadastrar ativo' })).toBeHidden();
  await expect(page.getByRole('button', { name: /Editar |Excluir / })).toHaveCount(0);
});
test('papel de Requests não concede perfil de Assets', async ({ page }) => {
  await fixture(page, { wrongAppRole: true }); await page.goto('/');
  await expect(page.getByText('Sem perfil de ativos')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('não tem permissão');
  await expect(page.getByRole('button', { name: 'Cadastrar ativo' })).toBeHidden();
});
test('403 preserva os dados do formulário', async ({ page }) => {
  await fixture(page, { denyWrite: true }); await page.goto('/');
  await page.getByLabel('Nome obrigatório').fill('Ativo pendente');
  await page.getByRole('button', { name: 'Cadastrar ativo' }).click();
  await expect(page.getByRole('status')).toContainText('não tem permissão');
  await expect(page.getByLabel('Nome obrigatório')).toHaveValue('Ativo pendente');
});
test('sessão expirada pede novo login', async ({ page }) => {
  await fixture(page, { expired: true }); await page.goto('/');
  await expect(page.getByRole('link', { name: 'Entrar novamente' })).toBeVisible();
});
test('edição pode ser cancelada e layout cabe no celular', async ({ page }) => {
  await fixture(page); await page.goto('/');
  await page.getByRole('button', { name: 'Editar Notebook do laboratório' }).click();
  await page.getByRole('button', { name: 'Cancelar edição' }).click();
  await expect(page.getByLabel('Nome obrigatório')).toHaveValue('');
  await page.screenshot({ path: '/tmp/cap-assets-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/cap-assets-mobile.png', fullPage: true });
});
