const api = '/odata/v4/assets/Assets';
const $ = id => document.getElementById(id);
let canEdit = false;
let editingId = null;

function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}
function failure(status) {
  if (status === 401) {
    $('login-again').hidden = false;
    return new Error('Sua sessão expirou. Entre novamente para continuar.');
  }
  if (status === 403) return new Error('Seu usuário não tem permissão para esta ação. Solicite o perfil de consulta ou edição de ativos.');
  return new Error('Não foi possível concluir a operação. Tente novamente.');
}
async function request(url, method = 'GET', body) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  if (method !== 'GET') {
    const token = await fetch('/odata/v4/assets/', { headers: { ...headers, 'X-CSRF-Token': 'Fetch' }, credentials: 'same-origin' });
    if (!token.ok) throw failure(token.status);
    headers['X-CSRF-Token'] = token.headers.get('x-csrf-token');
    if (!headers['X-CSRF-Token']) throw new Error('Não foi possível validar sua sessão. Atualize a página.');
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, { method, headers, credentials: 'same-origin', ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw failure(response.status);
  return response.status === 204 ? null : response.json();
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function busy(value) {
  document.querySelectorAll('button').forEach(element => { element.disabled = value; });
  $('asset-list').setAttribute('aria-busy', String(value));
}
function resetForm() {
  editingId = null;
  $('asset-form').reset();
  $('form-title').textContent = 'Novo ativo';
  $('save-button').textContent = 'Cadastrar ativo';
  $('cancel-edit').hidden = true;
}
function render(rows) {
  $('asset-list').replaceChildren();
  $('empty').hidden = rows.length !== 0;
  for (const row of rows) {
    const item = node('article', undefined, 'request');
    const info = node('div', undefined, 'request-info');
    info.append(node('h3', row.name));
    info.append(node('p', `Número de série: ${row.serialNumber || 'Não informado'}`));
    if (row.createdAt) info.append(node('small', `Cadastrado em ${new Date(row.createdAt).toLocaleDateString('pt-BR')}`));
    item.append(info);
    if (canEdit) {
      const actions = node('div', undefined, 'actions');
      const edit = node('button', 'Editar', 'secondary');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Editar ${row.name}`);
      edit.addEventListener('click', () => {
        editingId = row.ID;
        $('name').value = row.name;
        $('serial-number').value = row.serialNumber || '';
        $('form-title').textContent = 'Editar ativo';
        $('save-button').textContent = 'Salvar alterações';
        $('cancel-edit').hidden = false;
        $('name').focus();
      });
      const remove = node('button', 'Excluir', 'danger');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Excluir ${row.name}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm('Excluir este ativo?')) return;
        busy(true);
        try {
          await request(`${api}(${encodeURIComponent(row.ID)})`, 'DELETE');
          if (editingId === row.ID) resetForm();
          await load();
          notice('Ativo excluído.');
        } catch (error) { notice(error.message, true); }
        finally { busy(false); }
      });
      actions.append(edit, remove);
      item.append(actions);
    }
    $('asset-list').append(item);
  }
}
async function load() {
  const data = await request(`${api}?$orderby=createdAt%20desc&$top=100&$count=true`);
  render(data.value);
  const total = data['@odata.count'] ?? data.value.length;
  $('count').textContent = total > 100 ? `Exibindo os 100 mais recentes de ${total} ativos` : `${total} ${total === 1 ? 'ativo' : 'ativos'}`;
}
$('cancel-edit').addEventListener('click', resetForm);
$('refresh').addEventListener('click', async () => {
  busy(true);
  try { await load(); notice(); }
  catch (error) { notice(error.message, true); }
  finally { busy(false); }
});
$('asset-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('name').value.trim();
  if (!name) { $('name').focus(); return; }
  const wasEditing = editingId !== null;
  busy(true);
  try {
    await request(wasEditing ? `${api}(${encodeURIComponent(editingId)})` : api, wasEditing ? 'PATCH' : 'POST', { name, serialNumber: $('serial-number').value.trim() });
    resetForm();
    await load();
    notice(wasEditing ? 'Ativo atualizado.' : 'Ativo cadastrado.');
  } catch (error) { notice(error.message, true); }
  finally { busy(false); }
});
async function start() {
  busy(true);
  try {
    const user = await request('/user-api/currentUser');
    $('user-name').textContent = user.displayName || user.name || 'Usuário conectado';
    const scopes = Array.isArray(user.scopes) ? user.scopes : [];
    canEdit = scopes.some(scope => scope.endsWith('.AssetsEditor'));
    const canRead = canEdit || scopes.some(scope => scope.endsWith('.AssetsViewer'));
    $('access-level').textContent = canEdit ? 'Perfil de edição' : canRead ? 'Perfil de consulta' : 'Sem perfil de ativos';
    $('create-panel').hidden = !canEdit;
    await load();
  } catch (error) { $('count').textContent = 'Não foi possível carregar os ativos.'; notice(error.message, true); }
  finally { busy(false); }
}
void start();
