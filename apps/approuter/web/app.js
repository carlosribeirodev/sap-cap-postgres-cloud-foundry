const api = '/odata/v4/requests/Requests';
const $ = id => document.getElementById(id);
const labels = { OPEN: 'Aberta', IN_PROGRESS: 'Em andamento', DONE: 'Concluída' };
let canEdit = false;

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
  if (status === 403) return new Error('Seu usuário não tem permissão para esta ação. Solicite o perfil de consulta ou edição.');
  return new Error('Não foi possível concluir a operação. Tente novamente.');
}
async function request(url, method = 'GET', body) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  if (method !== 'GET') {
    const token = await fetch('/odata/v4/requests/', { headers: { ...headers, 'X-CSRF-Token': 'Fetch' }, credentials: 'same-origin' });
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
  document.querySelectorAll('button, select').forEach(element => { element.disabled = value; });
  $('request-list').setAttribute('aria-busy', String(value));
}
async function change(method, row, body) {
  busy(true);
  try {
    await request(`${api}(${encodeURIComponent(row.ID)})`, method, body);
    await load();
    notice(method === 'DELETE' ? 'Solicitação excluída.' : 'Status atualizado.');
  } catch (error) { notice(error.message, true); }
  finally { busy(false); }
}
function render(rows) {
  $('request-list').replaceChildren();
  $('empty').hidden = rows.length !== 0;
  for (const row of rows) {
    const item = node('article', undefined, 'request');
    const info = node('div', undefined, 'request-info');
    info.append(node('h3', row.title));
    if (row.description) info.append(node('p', row.description));
    if (row.createdAt) info.append(node('small', `Criada em ${new Date(row.createdAt).toLocaleDateString('pt-BR')}`));
    const actions = node('div', undefined, 'actions');
    if (canEdit) {
      const select = node('select');
      select.setAttribute('aria-label', `Status de ${row.title}`);
      for (const [value, text] of Object.entries(labels)) {
        const option = node('option', text);
        option.value = value;
        select.append(option);
      }
      if (!Object.hasOwn(labels, row.status)) {
        const option = node('option', row.status || 'Sem status');
        option.value = row.status || '';
        select.append(option);
      }
      select.value = row.status || '';
      select.addEventListener('change', () => {
        const status = select.value;
        select.value = row.status || '';
        void change('PATCH', row, { status });
      });
      const remove = node('button', 'Excluir', 'danger');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Excluir ${row.title}`);
      remove.addEventListener('click', () => {
        if (window.confirm('Excluir esta solicitação?')) void change('DELETE', row);
      });
      actions.append(select, remove);
    } else {
      const badge = node('span', labels[row.status] || row.status || 'Sem status', 'status');
      badge.dataset.status = row.status;
      actions.append(badge);
    }
    item.append(info, actions);
    $('request-list').append(item);
  }
}
async function load() {
  const data = await request(`${api}?$orderby=createdAt%20desc&$top=100&$count=true`);
  render(data.value);
  const total = data['@odata.count'] ?? data.value.length;
  $('count').textContent = total > 100 ? `Exibindo as 100 mais recentes de ${total} solicitações` : `${total} ${total === 1 ? 'solicitação' : 'solicitações'}`;
}
$('refresh').addEventListener('click', async () => {
  busy(true);
  try { await load(); notice(); }
  catch (error) { notice(error.message, true); }
  finally { busy(false); }
});
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const title = $('title').value.trim();
  if (!title) { $('title').focus(); return; }
  busy(true);
  try {
    await request(api, 'POST', { title, description: $('description').value.trim(), status: 'OPEN' });
    $('create-form').reset();
    await load();
    notice('Solicitação criada.');
  } catch (error) { notice(error.message, true); }
  finally { busy(false); }
});
async function start() {
  busy(true);
  try {
    const user = await request('/user-api/currentUser');
    $('user-name').textContent = user.displayName || user.name || 'Usuário conectado';
    const scopes = Array.isArray(user.scopes) ? user.scopes : [];
    canEdit = scopes.some(scope => scope.endsWith('.RequestsEditor'));
    $('access-level').textContent = canEdit ? 'Perfil de edição' : 'Perfil de consulta';
    $('create-panel').hidden = !canEdit;
    await load();
  } catch (error) { $('count').textContent = 'Não foi possível carregar as solicitações.'; notice(error.message, true); }
  finally { busy(false); }
}
void start();
