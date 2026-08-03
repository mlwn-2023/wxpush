const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = { recipients: [], messages: [], templates: [], schedules: [], tokens: [], editingId: null, selectedMessages: new Set() };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.msg || `请求失败 (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = 'toast', 2600);
}

async function init() {
  try { await api('/api/auth/me'); showApp(); await loadAll(); } catch { $('#loginView').classList.remove('hidden'); }
  setInterval(() => $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()), 1000);
}

function showApp() { $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden'); }

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#loginError').textContent = '';
  const form = new FormData(e.currentTarget);
  try { await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); showApp(); await loadAll(); }
  catch (error) { $('#loginError').textContent = error.message; }
});

$('#logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
$('#menuBtn').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('#nav').addEventListener('click', e => { const button = e.target.closest('[data-page]'); if (button) navigate(button.dataset.page); });
document.addEventListener('click', e => { const button = e.target.closest('[data-goto]'); if (button) navigate(button.dataset.goto); });

const pageNames = { dashboard: '总览', compose: '发送消息', schedules: '定时发送', templates: '消息模板', recipients: '收件人', history: '推送记录', settings: '系统设置', api: 'API 接入' };
function navigate(page) {
  $$('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  $$('#nav [data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('#breadcrumb').textContent = `管理台 / ${pageNames[page]}`;
  $('#pageTitle').textContent = page === 'dashboard' ? greeting() : pageNames[page];
  $('.sidebar').classList.remove('open'); window.scrollTo({ top: 0, behavior: 'smooth' });
  if (page === 'history') loadMessages(); if (page === 'settings') loadSettings(); if(page==='schedules')loadSchedules(); if(page==='templates')loadTemplates(); if(page==='api')loadTokens();
}
function greeting() { const h = new Date().getHours(); return `${h < 11 ? '早上' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上'}好，管理员`; }

async function loadAll() { await Promise.all([loadDashboard(), loadRecipients(), loadMessages(), loadSettings(), loadTemplates(), loadSchedules(), loadTokens()]); }
async function loadDashboard() {
  const { stats, recent, configured } = await api('/api/dashboard');
  $('#statToday').textContent = stats.today; $('#statSuccess').textContent = stats.success; $('#statRecipients').textContent = stats.recipients; $('#statTotal').textContent = stats.total;
  $('#successRate').textContent = `成功率 ${stats.total ? Math.round(stats.success / stats.total * 100) : 0}%`;
  $('#configBanner').classList.toggle('hidden', configured); $('#wechatHealth').textContent = configured ? '配置完成' : '待配置'; $('#sideStatus').textContent = configured ? '微信通道已配置' : '配置待检查';
  renderRecent(recent);
}
function renderRecent(items) {
  const root = $('#recentList'); root.innerHTML = '';
  if (!items.length) { root.textContent = '暂无推送记录'; root.className = 'message-list empty-state'; return; }
  root.className = 'message-list'; items.forEach(item => root.append(messageItem(item)));
}
function messageItem(item) {
  const row = document.createElement('div'); row.className = 'message-item';
  const glyph = document.createElement('div'); glyph.className = 'msg-glyph'; glyph.textContent = item.status === 'success' ? '✓' : '!';
  const text = document.createElement('div'); const title = document.createElement('h4'); title.textContent = item.title; const meta = document.createElement('p'); meta.textContent = `${item.recipient_count} 位收件人 · ${formatDate(item.created_at)}`; text.append(title, meta);
  const badge = statusBadge(item.status); row.append(glyph, text, badge); return row;
}

async function loadRecipients() { const data = await api('/api/recipients'); state.recipients = data.recipients; renderRecipients(); renderRecipientChecks(); }
function renderRecipients() {
  const query = ($('#recipientSearch').value || '').toLowerCase(); const tbody = $('#recipientTable'); tbody.innerHTML = '';
  const items = state.recipients.filter(r => `${r.name} ${r.openid} ${r.group_name}`.toLowerCase().includes(query)); $('#recipientCount').textContent = `${state.recipients.length} 位收件人`;
  if (!items.length) return emptyRow(tbody, '暂无收件人，请先添加');
  items.forEach(r => { const tr = document.createElement('tr');
    const person = td(); const name = document.createElement('b'); name.textContent = r.name; const added = document.createElement('small'); added.textContent = `添加于 ${formatDate(r.created_at)}`; person.append(name, added);
    const group = td(r.group_name); const openid = td(mask(r.openid)); openid.className = 'openid'; const status = td(); status.append(statusBadge(r.enabled ? 'enabled' : 'disabled'));
    const actions = td(); actions.className = 'row-actions'; const edit = actionButton('编辑', () => openRecipient(r)); const del = actionButton('删除', () => deleteRecipient(r), true); actions.append(edit, del); tr.append(person, group, openid, status, actions); tbody.append(tr); });
}
function renderRecipientChecks() { const root = $('#recipientChecks'); root.innerHTML = ''; state.recipients.filter(r => r.enabled).forEach(r => { const label = document.createElement('label'); label.className = 'check-card'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = r.id; const div = document.createElement('div'); const b = document.createElement('b'); b.textContent = r.name; const small = document.createElement('small'); small.textContent = r.group_name; div.append(b, small); label.append(input, div); root.append(label); }); toggleChecks(); }
$('#recipientSearch').addEventListener('input', renderRecipients);
$('#addRecipientBtn').addEventListener('click', () => openRecipient());
$('#closeRecipient').addEventListener('click', () => $('#recipientDialog').close());
$('#cancelRecipient').addEventListener('click', () => $('#recipientDialog').close());
function openRecipient(recipient) { state.editingId = recipient?.id || null; const f = $('#recipientForm'); f.reset(); f.elements.enabled.checked = true; f.elements.group_name.value = '默认分组'; $('#recipientDialogTitle').textContent = recipient ? '编辑收件人' : '添加收件人'; $('#recipientError').textContent = ''; if (recipient) ['id','name','openid','group_name'].forEach(k => f.elements[k].value = recipient[k]); if (recipient) f.elements.enabled.checked = recipient.enabled; $('#recipientDialog').showModal(); }
$('#recipientForm').addEventListener('submit', async e => { e.preventDefault(); const f = e.currentTarget; const data = Object.fromEntries(new FormData(f)); data.enabled = f.elements.enabled.checked; delete data.id; try { await api(state.editingId ? `/api/recipients/${state.editingId}` : '/api/recipients', { method: state.editingId ? 'PUT' : 'POST', body: JSON.stringify(data) }); $('#recipientDialog').close(); toast('收件人已保存'); await loadRecipients(); await loadDashboard(); } catch (error) { $('#recipientError').textContent = error.message; } });
async function deleteRecipient(r) { if (!confirm(`确定删除“${r.name}”吗？`)) return; try { await api(`/api/recipients/${r.id}`, { method: 'DELETE' }); toast('收件人已删除'); await loadRecipients(); await loadDashboard(); } catch (error) { toast(error.message, true); } }

const sendForm = $('#sendForm');
sendForm.elements.title.addEventListener('input', e => { $('#titleCount').textContent = `${e.target.value.length} / 40`; $('#previewTitle').textContent = e.target.value || '消息标题'; });
sendForm.elements.content.addEventListener('input', e => { $('#contentCount').textContent = `${e.target.value.length} / 500`; $('#previewContent').textContent = e.target.value || '消息内容将在这里实时预览。'; });
$('#sendAll').addEventListener('change', toggleChecks);
$('#composeTemplate').addEventListener('change', e => { const template=state.templates.find(t=>t.id===Number(e.target.value)); if(!template)return; sendForm.elements.title.value=template.title; sendForm.elements.content.value=template.content; sendForm.elements.title.dispatchEvent(new Event('input')); sendForm.elements.content.dispatchEvent(new Event('input')); });
function toggleChecks() { $$('#recipientChecks input').forEach(el => { el.disabled = $('#sendAll').checked; el.checked = false; }); }
sendForm.addEventListener('submit', async e => { e.preventDefault(); $('#sendError').textContent = ''; const button = $('button[type=submit]', sendForm); button.disabled = true; button.textContent = '正在发送…'; const recipientIds = $$('#recipientChecks input:checked').map(el => Number(el.value)); try { const result = await api('/api/messages/send', { method: 'POST', body: JSON.stringify({ title: sendForm.elements.title.value, content: sendForm.elements.content.value, all: $('#sendAll').checked, recipientIds }) }); toast(`发送完成：${result.successCount}/${result.total} 成功`); sendForm.reset(); $('#sendAll').checked = true; toggleChecks(); await loadDashboard(); navigate('history'); } catch (error) { $('#sendError').textContent = error.message; } finally { button.disabled = false; button.innerHTML = '确认发送 <span>↗</span>'; } });

async function loadMessages() { const data = await api('/api/messages?limit=300'); state.messages = data.messages; const validIds = new Set(state.messages.map(m => m.id)); state.selectedMessages = new Set([...state.selectedMessages].filter(id => validIds.has(id))); renderHistory(); }
function filteredMessages() { const q = ($('#historySearch').value || '').toLowerCase(), filter = $('#historyFilter').value; return state.messages.filter(m => (!filter || m.status === filter) && `${m.title} ${m.content}`.toLowerCase().includes(q)); }
function renderHistory() { const tbody = $('#historyTable'); tbody.innerHTML = ''; const items = filteredMessages(); if (!items.length) { updateSelectionControls(items); return emptyRow(tbody, '暂无匹配的推送记录', 7); } items.forEach(m => { const tr = document.createElement('tr'); const select = td(); select.className = 'select-cell'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selectedMessages.has(m.id); checkbox.setAttribute('aria-label', `选择 ${m.title}`); checkbox.addEventListener('change', () => { checkbox.checked ? state.selectedMessages.add(m.id) : state.selectedMessages.delete(m.id); updateSelectionControls(items); }); select.append(checkbox); const msg = td(); const b = document.createElement('b'); b.textContent = m.title; const small = document.createElement('small'); small.textContent = truncate(m.content, 50); msg.append(b, small); const count = td(`${m.success_count} / ${m.recipient_count}`); const source = td(m.source === 'api' ? 'API' : m.source === 'schedule' ? '定时任务' : m.source === 'retry' ? '重新发送' : '管理台'); const status = td(); status.append(statusBadge(m.status)); const time = td(formatDate(m.created_at)); const actions = td(); actions.className = 'row-actions'; actions.append(actionButton('重发', () => retryMessage(m)),actionButton('删除', () => deleteMessage(m), true)); tr.append(select, msg, count, source, status, time, actions); tbody.append(tr); }); updateSelectionControls(items); }
async function retryMessage(message){if(!await confirmDelete('重新发送这条消息？',`将再次向原来的 ${message.recipient_count} 位收件人发送“${message.title}”。`,'确认重发'))return;try{const result=await api(`/api/messages/${message.id}/retry`,{method:'POST'});toast(`重发完成：${result.successCount}/${result.total} 成功`);await Promise.all([loadMessages(),loadDashboard()]);}catch(error){toast(error.message,true);}}
function updateSelectionControls(visible = filteredMessages()) { const count = state.selectedMessages.size; $('#deleteSelected').disabled = count === 0; $('#selectedCount').textContent = count ? `(${count})` : ''; $('#deleteAll').disabled = state.messages.length === 0; const all = $('#selectAllMessages'); const selectedVisible = visible.filter(m => state.selectedMessages.has(m.id)).length; all.checked = visible.length > 0 && selectedVisible === visible.length; all.indeterminate = selectedVisible > 0 && selectedVisible < visible.length; all.disabled = visible.length === 0; }
async function deleteMessage(message) { if (!await confirmDelete('删除这条推送记录？', `“${message.title}”删除后无法恢复。`)) return; try { await api(`/api/messages/${message.id}`, { method: 'DELETE' }); state.selectedMessages.delete(message.id); toast('推送记录已删除'); await Promise.all([loadMessages(), loadDashboard()]); } catch (error) { toast(error.message, true); } }
async function deleteSelectedMessages() { const ids = [...state.selectedMessages]; if (!ids.length || !await confirmDelete(`删除选中的 ${ids.length} 条记录？`, '所选推送记录将被永久删除，此操作无法恢复。')) return; try { const result = await api('/api/messages', { method: 'DELETE', body: JSON.stringify({ ids }) }); state.selectedMessages.clear(); toast(`已删除 ${result.deleted} 条推送记录`); await Promise.all([loadMessages(), loadDashboard()]); } catch (error) { toast(error.message, true); } }
async function deleteAllMessages() { const count = state.messages.length; if (!count || !await confirmDelete(`删除全部 ${count} 条记录？`, '全部推送历史将被永久清空，此操作无法恢复。')) return; try { const result = await api('/api/messages', { method: 'DELETE', body: JSON.stringify({ all: true }) }); state.selectedMessages.clear(); toast(`已删除全部 ${result.deleted} 条推送记录`); await Promise.all([loadMessages(), loadDashboard()]); } catch (error) { toast(error.message, true); } }
function confirmDelete(title, message, acceptLabel='确认删除') { return new Promise(resolve => { const dialog = $('#confirmDialog'); $('#confirmTitle').textContent = title; $('#confirmMessage').textContent = message; $('#confirmAccept').textContent=acceptLabel; const finish = value => { dialog.close(); resolve(value); }; $('#confirmCancel').onclick = () => finish(false); $('#confirmAccept').onclick = () => finish(true); dialog.oncancel = e => { e.preventDefault(); finish(false); }; dialog.showModal(); }); }
$('#selectAllMessages').addEventListener('change', e => { const items = filteredMessages(); items.forEach(m => e.currentTarget.checked ? state.selectedMessages.add(m.id) : state.selectedMessages.delete(m.id)); renderHistory(); });
$('#deleteSelected').addEventListener('click', deleteSelectedMessages); $('#deleteAll').addEventListener('click', deleteAllMessages);
$('#historySearch').addEventListener('input', renderHistory); $('#historyFilter').addEventListener('change', renderHistory); $('#refreshHistory').addEventListener('click', loadMessages);

async function loadSettings() { const { settings } = await api('/api/settings'); const f = $('#settingsForm'); f.elements.appid.value = settings.appid || ''; f.elements.templateId.value = settings.templateId || ''; f.elements.baseUrl.value = settings.baseUrl || ''; f.elements.retentionDays.value=settings.retentionDays||90; $('#secretHint').textContent = settings.secretSet ? '（已安全保存）' : ''; $('#settingStatus').textContent = settings.appid && settings.secretSet && settings.templateId ? '已配置' : '待完善'; $('#settingStatus').classList.toggle('neutral', !(settings.appid && settings.secretSet && settings.templateId)); }
$('#settingsForm').addEventListener('submit', async e => { e.preventDefault(); const f = e.currentTarget; const data = Object.fromEntries(new FormData(f)); try { await api('/api/settings', { method: 'PUT', body: JSON.stringify(data) }); toast('系统设置已保存'); f.elements.secret.value = ''; await loadSettings(); await loadDashboard(); } catch (error) { toast(error.message, true); } });
$('#testWechat').addEventListener('click', async e => { const button = e.currentTarget; button.disabled = true; button.textContent = '检测中…'; const form = $('#settingsForm'); const values = Object.fromEntries(new FormData(form)); try { const r = await api('/api/settings/test', { method: 'POST', body: JSON.stringify(values) }); toast(r.message); } catch (error) { toast(error.message, true); } finally { button.disabled = false; button.textContent = '测试微信连接'; } });
$('#downloadBackup').addEventListener('click',()=>download('/api/data/backup'));
$('#exportCsv').addEventListener('click',()=>download('/api/data/messages.csv'));
$('#cleanupNow').addEventListener('click',async()=>{const days=Number($('#settingsForm').elements.retentionDays.value)||90;if(!await confirmDelete('立即清理旧记录？',`将删除 ${days} 天以前的推送记录，删除后无法恢复。`))return;try{await api('/api/settings',{method:'PUT',body:JSON.stringify({retentionDays:days})});const r=await api('/api/data/cleanup',{method:'POST'});toast(`已清理 ${r.deleted} 条旧记录`);await Promise.all([loadMessages(),loadDashboard()]);}catch(e){toast(e.message,true);}});

async function loadTemplates(){const data=await api('/api/templates');state.templates=data.templates;renderTemplates();populateTemplateSelect($('#composeTemplate'));populateTemplateSelect($('#scheduleTemplate'));}
function populateTemplateSelect(select){const current=select.value;select.innerHTML='<option value="">不使用模板</option>';state.templates.forEach(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.name;select.append(o);});select.value=state.templates.some(t=>String(t.id)===current)?current:'';}
function renderTemplates(){const root=$('#templateGrid');root.innerHTML='';if(!state.templates.length){root.className='template-grid empty-state panel';root.textContent='暂无消息模板';return;}root.className='template-grid';state.templates.forEach(t=>{const card=document.createElement('article');card.className='panel template-card';const tag=document.createElement('p');tag.className='eyebrow green';tag.textContent=t.name;const title=document.createElement('h3');title.textContent=t.title;const content=document.createElement('p');content.textContent=truncate(t.content,100);const actions=document.createElement('div');actions.className='button-row';actions.append(actionButton('套用发送',()=>{navigate('compose');$('#composeTemplate').value=t.id;$('#composeTemplate').dispatchEvent(new Event('change'));}),actionButton('编辑',()=>openTemplate(t)),actionButton('删除',()=>deleteTemplate(t),true));card.append(tag,title,content,actions);root.append(card);});}
function openTemplate(t){const f=$('#templateForm');f.reset();state.editingTemplate=t?.id||null;$('#templateDialogTitle').textContent=t?'编辑消息模板':'新建消息模板';if(t)['name','title','content'].forEach(k=>f.elements[k].value=t[k]);$('#templateDialog').showModal();}
$('#addTemplateBtn').addEventListener('click',()=>openTemplate());$('#closeTemplate').addEventListener('click',()=>$('#templateDialog').close());$('#cancelTemplate').addEventListener('click',()=>$('#templateDialog').close());
$('#templateForm').addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));try{await api(state.editingTemplate?`/api/templates/${state.editingTemplate}`:'/api/templates',{method:state.editingTemplate?'PUT':'POST',body:JSON.stringify(data)});$('#templateDialog').close();toast('消息模板已保存');await loadTemplates();}catch(error){toast(error.message,true);}});
async function deleteTemplate(t){if(!await confirmDelete('删除这个消息模板？',`“${t.name}”删除后无法恢复。`))return;try{await api(`/api/templates/${t.id}`,{method:'DELETE'});toast('消息模板已删除');await loadTemplates();}catch(e){toast(e.message,true);}}

async function loadSchedules(){const data=await api('/api/schedules');state.schedules=data.schedules;renderSchedules();}
function renderSchedules(){const root=$('#scheduleTable');root.innerHTML='';if(!state.schedules.length)return emptyRow(root,'暂无定时任务',6);state.schedules.forEach(s=>{const tr=document.createElement('tr');const name=td();const b=document.createElement('b');b.textContent=s.name;const small=document.createElement('small');small.textContent=truncate(s.title,40);name.append(b,small);const recurrence=td(({once:'仅一次',daily:'每天',weekly:'每周'})[s.recurrence]);const next=td(formatFullDate(s.next_run_at));const last=td(s.last_status?statusLabel(s.last_status):'尚未执行');const status=td();status.append(statusBadge(s.enabled?'enabled':'disabled'));const actions=td();actions.className='row-actions';actions.append(actionButton('立即执行',()=>runSchedule(s)),actionButton('编辑',()=>openSchedule(s)),actionButton('删除',()=>deleteSchedule(s),true));tr.append(name,recurrence,next,last,status,actions);root.append(tr);});}
function openSchedule(s){const f=$('#scheduleForm');f.reset();$('#scheduleTemplate').value='';state.editingSchedule=s?.id||null;f.elements.sendAll.checked=true;f.elements.enabled.checked=true;$('#scheduleDialogTitle').textContent=s?'编辑定时任务':'新建定时任务';renderScheduleRecipients(s?.recipient_ids||[]);if(s){['name','title','content','recurrence'].forEach(k=>f.elements[k].value=s[k]);f.elements.nextRunAt.value=toLocalInput(s.next_run_at);f.elements.sendAll.checked=s.send_all;f.elements.enabled.checked=s.enabled;}toggleScheduleRecipients();$('#scheduleDialog').showModal();}
function renderScheduleRecipients(selected=[]){const root=$('#scheduleRecipients');root.innerHTML='';state.recipients.filter(r=>r.enabled).forEach(r=>{const label=document.createElement('label');label.className='check-card';const input=document.createElement('input');input.type='checkbox';input.value=r.id;input.checked=selected.includes(r.id);const span=document.createElement('span');span.textContent=r.name;label.append(input,span);root.append(label);});}
function toggleScheduleRecipients(){$$('#scheduleRecipients input').forEach(i=>i.disabled=$('#scheduleForm').elements.sendAll.checked);}
$('#scheduleForm').elements.sendAll.addEventListener('change',toggleScheduleRecipients);$('#addScheduleBtn').addEventListener('click',()=>openSchedule());$('#closeSchedule').addEventListener('click',()=>$('#scheduleDialog').close());$('#cancelSchedule').addEventListener('click',()=>$('#scheduleDialog').close());
$('#scheduleTemplate').addEventListener('change',e=>{const template=state.templates.find(t=>t.id===Number(e.target.value));if(!template)return;const form=$('#scheduleForm');form.elements.title.value=template.title;form.elements.content.value=template.content;});
$('#scheduleForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;const data=Object.fromEntries(new FormData(f));data.nextRunAt=new Date(f.elements.nextRunAt.value).toISOString();data.sendAll=f.elements.sendAll.checked;data.enabled=f.elements.enabled.checked;data.recipientIds=$$('#scheduleRecipients input:checked').map(i=>Number(i.value));try{await api(state.editingSchedule?`/api/schedules/${state.editingSchedule}`:'/api/schedules',{method:state.editingSchedule?'PUT':'POST',body:JSON.stringify(data)});$('#scheduleDialog').close();toast('定时任务已保存');await loadSchedules();}catch(error){toast(error.message,true);}});
async function runSchedule(s){if(!await confirmDelete('立即执行这个任务？',`现在发送“${s.title}”，不会改变下次计划时间。`,'立即执行'))return;try{const r=await api(`/api/schedules/${s.id}/run`,{method:'POST'});toast(`发送完成：${r.successCount}/${r.total} 成功`);await Promise.all([loadMessages(),loadDashboard(),loadSchedules()]);}catch(e){toast(e.message,true);}}
async function deleteSchedule(s){if(!await confirmDelete('删除这个定时任务？',`“${s.name}”删除后不会再自动执行。`))return;try{await api(`/api/schedules/${s.id}`,{method:'DELETE'});toast('定时任务已删除');await loadSchedules();}catch(e){toast(e.message,true);}}

async function loadTokens(){const data=await api('/api/tokens');state.tokens=data.tokens;const root=$('#tokenList');root.innerHTML='';if(!state.tokens.length){root.className='token-list empty-state';root.textContent='暂无独立调用 Token';return;}root.className='token-list';state.tokens.forEach(t=>{const row=document.createElement('div');row.className='token-row';const info=document.createElement('div');const b=document.createElement('b');b.textContent=t.name;const small=document.createElement('small');small.textContent=`${t.token_prefix} · 最近使用 ${t.last_used_at?formatDate(t.last_used_at):'从未'}`;info.append(b,small);const actions=document.createElement('div');actions.className='row-actions';actions.append(actionButton(t.enabled?'停用':'启用',()=>toggleToken(t)),actionButton('删除',()=>deleteToken(t),true));row.append(info,statusBadge(t.enabled?'enabled':'disabled'),actions);root.append(row);});}
$('#newTokenForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;try{const r=await api('/api/tokens',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});f.reset();await loadTokens();await showGeneratedToken(r.token);}catch(error){toast(error.message,true);}});
async function showGeneratedToken(token){await navigator.clipboard?.writeText(token).catch(()=>{});alert(`Token 已生成并尝试复制到剪贴板。请立即保存，关闭后无法再次查看：\n\n${token}`);}
async function toggleToken(t){try{await api(`/api/tokens/${t.id}`,{method:'PATCH',body:JSON.stringify({enabled:!t.enabled})});await loadTokens();}catch(e){toast(e.message,true);}}
async function deleteToken(t){if(!await confirmDelete('删除这个 API Token？',`“${t.name}”将立即无法调用推送接口。`))return;try{await api(`/api/tokens/${t.id}`,{method:'DELETE'});toast('API Token 已删除');await loadTokens();}catch(e){toast(e.message,true);}}

function td(text) { const el = document.createElement('td'); if (text !== undefined) el.textContent = text; return el; }
function emptyRow(root, text, colspan = 6) { const tr = document.createElement('tr'), cell = td(text); cell.colSpan = colspan; cell.className = 'empty-state'; cell.style.height = '180px'; tr.append(cell); root.append(tr); }
function actionButton(text, fn, danger = false) { const b = document.createElement('button'); b.type = 'button'; b.className = `icon-btn${danger ? ' danger' : ''}`; b.textContent = text; b.onclick = fn; return b; }
function statusBadge(status) { const el = document.createElement('span'); const labels = { success: '发送成功', partial: '部分成功', failed: '发送失败', enabled: '已启用', disabled: '已停用' }; el.textContent = labels[status] || status; el.className = `status ${status}`; return el; }
function formatDate(value) { if (!value) return '—'; return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(`${value.replace(' ', 'T')}Z`)); }
function formatFullDate(value){if(!value)return'—';return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}
function toLocalInput(value){const d=new Date(value),offset=d.getTimezoneOffset();return new Date(d.getTime()-offset*60000).toISOString().slice(0,16);}
function statusLabel(status){return({success:'发送成功',partial:'部分成功',failed:'发送失败',running:'执行中'})[status]||status;}
function download(url){const a=document.createElement('a');a.href=url;a.download='';document.body.append(a);a.click();a.remove();}
function mask(value) { return value.length < 12 ? value : `${value.slice(0, 6)}••••${value.slice(-5)}`; }
function truncate(value, n) { return value.length > n ? `${value.slice(0, n)}…` : value; }

init();
