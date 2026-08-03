import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { createStore } from './db.js';
import { sendWechatMessage, verifyWechat } from './wechat.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = resolve(ROOT, 'public');
const JSON_LIMIT = 1024 * 1024;
const SIGN_MAX_SKEW_MS = 60 * 60 * 1000;

export function createApp(options = {}) {
  const env = { ...process.env, ...options.env };
  if ((env.NODE_ENV || 'development') === 'production') {
    for (const key of ['ADMIN_PASSWORD', 'APP_KEY', 'API_TOKEN']) {
      if (!env[key] || env[key].startsWith('replace-') || env[key].startsWith('change-')) throw new Error(`生产环境必须设置安全的 ${key}`);
    }
  }
  const dataDir = resolve(options.dataDir || env.DATA_DIR || resolve(ROOT, 'data'));
  const store = options.store || createStore(resolve(dataDir, 'wxpush.db'));
  const fetchImpl = options.fetchImpl || fetch;
  const adminUsername = env.ADMIN_USERNAME || 'admin';
  const adminPassword = env.ADMIN_PASSWORD || 'wxpush123456';
  const appKey = env.APP_KEY || 'wxpush-local-development-key';
  const passwordSalt = createHash('sha256').update(appKey).digest('hex').slice(0, 32);
  const adminPasswordHash = scryptSync(adminPassword, passwordSalt, 32);
  const apiTokenHash = hashToken(env.API_TOKEN || store.getSetting('api_token') || 'wxpush-local-token');
  const requireApiSign = String(env.REQUIRE_API_SIGN ?? ((env.NODE_ENV || 'development') === 'production')).toLowerCase() === 'true';
  const loginAttempts = new Map();

  seedSettings(store, env);

  const server = http.createServer(async (req, res) => {
    try {
      setSecurityHeaders(res);
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'wxpush', time: new Date().toISOString() });
      const detailMatch = url.pathname.match(/^\/detail\/([a-f0-9]{32,64})$/);
      if (req.method === 'GET' && detailMatch) return serveDetail(res, store.getMessageByPublicId(detailMatch[1]));
      if (url.pathname === '/wxsend') return await handleLegacySend(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.statusCode || (String(error.code || '').includes('SQLITE_CONSTRAINT') ? 409 : 500);
      if (status >= 500) console.error(error);
      const message = status === 409 ? '该 OpenID 已存在' : status >= 500 ? '服务器内部错误' : error.message;
      return json(res, status, { error: message });
    }
  });

  const schedulerTimer = setInterval(runDueSchedules, Number(options.schedulerIntervalMs || 30000));
  schedulerTimer.unref();
  server.on('close', () => clearInterval(schedulerTimer));
  const cleanupTimer = setInterval(() => store.cleanupMessages(store.getSetting('retention_days', '90')), 6 * 60 * 60 * 1000);
  cleanupTimer.unref();
  server.on('close', () => clearInterval(cleanupTimer));

  async function handleApi(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const client = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(client);
      if (attempt?.blockedUntil > Date.now()) return json(res, 429, { error: '尝试次数过多，请稍后再试' });
      const body = await readJson(req);
      const supplied = scryptSync(String(body.password || ''), passwordSalt, 32);
      const valid = String(body.username || '') === adminUsername && timingSafeEqual(supplied, adminPasswordHash);
      if (!valid) {
        const failures = (attempt?.failures || 0) + 1;
        loginAttempts.set(client, { failures, blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
        return json(res, 401, { error: '用户名或密码错误' });
      }
      loginAttempts.delete(client);
      const rawToken = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      store.cleanupSessions(Date.now());
      store.addSession(hashToken(rawToken), expiresAt);
      const secureCookie = String(env.COOKIE_SECURE || '').toLowerCase() === 'true';
      res.setHeader('set-cookie', `wxpush_session=${rawToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secureCookie ? '; Secure' : ''}`);
      return json(res, 200, { ok: true, username: adminUsername });
    }

    const session = requireSession(req, store);
    if (!session) return json(res, 401, { error: '登录已失效，请重新登录' });
    if (isWrite(req.method) && !validOrigin(req)) return json(res, 403, { error: '请求来源校验失败' });

    if (req.method === 'GET' && url.pathname === '/api/auth/me') return json(res, 200, { username: adminUsername });
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      store.deleteSession(session);
      res.setHeader('set-cookie', 'wxpush_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return json(res, 200, { stats: store.stats(), recent: store.listMessages(6), configured: getConfig(store, appKey).configured });
    }
    if (req.method === 'GET' && url.pathname === '/api/recipients') return json(res, 200, { recipients: store.listRecipients() });
    if (req.method === 'POST' && url.pathname === '/api/recipients') {
      const body = validateRecipient(await readJson(req));
      const id = store.addRecipient(body);
      return json(res, 201, { recipient: store.getRecipient(id) });
    }
    const recipientMatch = url.pathname.match(/^\/api\/recipients\/(\d+)$/);
    if (recipientMatch && req.method === 'PUT') {
      const body = validateRecipient(await readJson(req));
      if (!store.updateRecipient(Number(recipientMatch[1]), body)) return json(res, 404, { error: '收件人不存在' });
      return json(res, 200, { recipient: store.getRecipient(Number(recipientMatch[1])) });
    }
    if (recipientMatch && req.method === 'DELETE') {
      if (!store.deleteRecipient(Number(recipientMatch[1]))) return json(res, 404, { error: '收件人不存在' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') return json(res, 200, { messages: store.listMessages(url.searchParams.get('limit')) });
    if (req.method === 'DELETE' && url.pathname === '/api/messages') {
      const body = await readJson(req);
      if (body.all === true) return json(res, 200, { ok: true, deleted: store.deleteAllMessages() });
      const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0) : [])];
      if (!ids.length) return json(res, 400, { error: '请选择要删除的推送记录' });
      if (ids.length > 500) return json(res, 400, { error: '单次最多删除 500 条记录' });
      return json(res, 200, { ok: true, deleted: store.deleteMessages(ids) });
    }
    const messageMatch = url.pathname.match(/^\/api\/messages\/(\d+)$/);
    if (messageMatch && req.method === 'DELETE') {
      if (!store.deleteMessage(Number(messageMatch[1]))) return json(res, 404, { error: '推送记录不存在' });
      return json(res, 200, { ok: true });
    }
    const retryMatch = url.pathname.match(/^\/api\/messages\/(\d+)\/retry$/);
    if (retryMatch && req.method === 'POST') {
      const original = store.getMessage(Number(retryMatch[1]));
      if (!original) return json(res, 404, { error: '推送记录不存在' });
      return sendAndRecord(res, { title: original.title, content: original.content, recipients: original.recipients, wechatTemplateId: original.wechat_template_id, wechatData: original.wechat_data, source: 'retry' });
    }
    if (req.method === 'POST' && url.pathname === '/api/messages/send') {
      const body = await readJson(req);
      const recipients = resolveRecipients(body, store);
      return sendAndRecord(res, { title: body.title, content: body.content, recipients, wechatTemplateId: body.wechatTemplateId, wechatData: body.wechatData, source: 'console' });
    }
    if (req.method === 'GET' && url.pathname === '/api/templates') return json(res, 200, { templates: store.listTemplates() });
    if (req.method === 'POST' && url.pathname === '/api/templates') { const body=validateTemplate(await readJson(req)); const id=store.addTemplate(body); return json(res,201,{template:store.getTemplate(id)}); }
    const templateMatch=url.pathname.match(/^\/api\/templates\/(\d+)$/);
    if(templateMatch&&req.method==='PUT'){const body=validateTemplate(await readJson(req));if(!store.updateTemplate(Number(templateMatch[1]),body))return json(res,404,{error:'消息模板不存在'});return json(res,200,{template:store.getTemplate(Number(templateMatch[1]))});}
    if(templateMatch&&req.method==='DELETE'){if(!store.deleteTemplate(Number(templateMatch[1])))return json(res,404,{error:'消息模板不存在'});return json(res,200,{ok:true});}
    if(req.method==='GET'&&url.pathname==='/api/tokens')return json(res,200,{tokens:store.listTokens()});
    if(req.method==='POST'&&url.pathname==='/api/tokens'){const body=await readJson(req);const name=String(body.name||'').trim();if(!name) return json(res,400,{error:'请输入 Token 名称'});const token=`wxp_${randomBytes(24).toString('base64url')}`;const id=store.addToken({name,tokenHash:hashToken(token),prefix:`${token.slice(0,10)}…`});return json(res,201,{id,token});}
    const tokenMatch=url.pathname.match(/^\/api\/tokens\/(\d+)$/);
    if(tokenMatch&&req.method==='PATCH'){const body=await readJson(req);if(!store.setTokenEnabled(Number(tokenMatch[1]),body.enabled!==false))return json(res,404,{error:'API Token 不存在'});return json(res,200,{ok:true});}
    if(tokenMatch&&req.method==='DELETE'){if(!store.deleteToken(Number(tokenMatch[1])))return json(res,404,{error:'API Token 不存在'});return json(res,200,{ok:true});}
    if(req.method==='GET'&&url.pathname==='/api/schedules')return json(res,200,{schedules:store.listSchedules()});
    if(req.method==='POST'&&url.pathname==='/api/schedules'){const body=validateSchedule(await readJson(req));const id=store.addSchedule(body);return json(res,201,{schedule:store.getSchedule(id)});}
    const scheduleMatch=url.pathname.match(/^\/api\/schedules\/(\d+)$/);
    if(scheduleMatch&&req.method==='PUT'){const body=validateSchedule(await readJson(req));if(!store.updateSchedule(Number(scheduleMatch[1]),body))return json(res,404,{error:'定时任务不存在'});return json(res,200,{schedule:store.getSchedule(Number(scheduleMatch[1]))});}
    if(scheduleMatch&&req.method==='DELETE'){if(!store.deleteSchedule(Number(scheduleMatch[1])))return json(res,404,{error:'定时任务不存在'});return json(res,200,{ok:true});}
    const scheduleRun=url.pathname.match(/^\/api\/schedules\/(\d+)\/run$/);
    if(scheduleRun&&req.method==='POST'){const schedule=store.getSchedule(Number(scheduleRun[1]));if(!schedule)return json(res,404,{error:'定时任务不存在'});try{const result=await dispatchMessage({title:schedule.title,content:schedule.content,recipients:resolveScheduleRecipients(schedule),wechatTemplateId:schedule.wechat_template_id,wechatData:schedule.wechat_data,source:'schedule'});store.updateScheduleRun(schedule.id,{enabled:schedule.enabled,nextRunAt:schedule.next_run_at,status:result.status,error:result.error});return json(res,result.successCount?200:502,result);}catch(error){store.updateScheduleRun(schedule.id,{enabled:schedule.enabled,nextRunAt:schedule.next_run_at,status:'failed',error:error.message});return json(res,502,{error:error.message});}}
    if(req.method==='GET'&&url.pathname==='/api/data/messages.csv')return serveCsv(res,store.allMessages());
    if(req.method==='GET'&&url.pathname==='/api/data/backup'){store.checkpoint();const bytes=await readFile(store.filename);res.writeHead(200,{'content-type':'application/vnd.sqlite3','content-disposition':`attachment; filename="wxpush-${new Date().toISOString().slice(0,10)}.db"`,'content-length':bytes.length});return res.end(bytes);}
    if(req.method==='POST'&&url.pathname==='/api/data/cleanup'){const days=Number(store.getSetting('retention_days','90'));return json(res,200,{ok:true,deleted:store.cleanupMessages(days)});}
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const config = getConfig(store, appKey);
      return json(res, 200, { settings: { appid: config.appid, secretSet: Boolean(config.secret), templateId: config.templateId, baseUrl: config.baseUrl, apiTokenSet: Boolean(env.API_TOKEN || store.getSetting('api_token_hash')), retentionDays:Number(store.getSetting('retention_days','90')) } });
    }
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const body = await readJson(req);
      if (body.appid !== undefined) store.setSetting('wx_appid', String(body.appid).trim());
      if (body.secret) store.setSetting('wx_secret', encrypt(String(body.secret), appKey));
      if (body.templateId !== undefined) store.setSetting('wx_template_id', String(body.templateId).trim());
      if (body.baseUrl !== undefined) store.setSetting('wx_base_url', String(body.baseUrl).trim());
      if (body.apiToken) store.setSetting('api_token_hash', hashToken(String(body.apiToken)));
      if (body.retentionDays !== undefined) store.setSetting('retention_days', String(Math.min(Math.max(Number(body.retentionDays)||90,7),3650)));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/test') {
      const body = await readJson(req);
      const saved = getConfig(store, appKey);
      const config = {
        appid: String(body.appid ?? saved.appid).trim(),
        secret: String(body.secret || saved.secret).trim(),
        templateId: String(body.templateId ?? saved.templateId).trim(),
        baseUrl: String(body.baseUrl ?? saved.baseUrl).trim()
      };
      if (!config.appid || !config.secret) return json(res, 400, { error: '请填写微信 AppID 和 AppSecret' });
      try {
        const result = await verifyWechat(config, fetchImpl);
        return json(res, 200, result);
      } catch (error) {
        return json(res, 502, { error: `微信连接失败：${error.message}` });
      }
    }
    return json(res, 404, { error: 'API not found' });
  }

  async function handleLegacySend(req, res, url) {
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { msg: 'Method not allowed' });
    const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const supplied = headerToken || url.searchParams.get('token') || '';
    const storedHash = store.getSetting('api_token_hash');
    const suppliedHash = hashToken(supplied);
    const valid = safeHashEqual(suppliedHash, storedHash || apiTokenHash) || store.validateToken(suppliedHash);
    if (!valid) return json(res, 403, { msg: 'Invalid token' });
    const body = req.method === 'POST' ? await readJson(req, true) : {};
    const params = { ...Object.fromEntries(url.searchParams), ...body };
    if (requireApiSign || params.timestamp || params.sign) {
      const signature = verifySmsForwarderSignature(params.timestamp, params.sign, supplied, store);
      if (!signature.ok) return json(res, 403, { msg: signature.error });
    }
    const directRecipients = parseRecipientSelector(params.userid);
    const groups = parseRecipientSelector(params.group ?? params.groups ?? params.group_name);
    const recipients = directRecipients.length
      ? directRecipients
      : groups.length
        ? store.enabledOpenidsByGroups(groups)
        : store.enabledOpenids();
    return sendAndRecord(res, { title: params.title || params.from || 'SmsForwarder', content: params.content, recipients, wechatTemplateId: params.templateId || params.template_id, wechatData: params.wechatData || params.data, source: 'api', legacy: true });
  }

  async function sendAndRecord(res, input) {
    try {
      const payload = await dispatchMessage(input);
      return json(res, payload.successCount ? 200 : 502, input.legacy ? { msg: payload.successCount ? `Successfully sent messages to ${payload.successCount} user(s).` : payload.error } : payload);
    } catch (error) {
      return json(res, error.statusCode || 502, input.legacy ? { msg: error.message } : { error: error.message });
    }
  }

  async function dispatchMessage(input) {
    const title = String(input.title || '').trim();
    const content = String(input.content || '').trim();
    if (!title || !content) throw httpError(400, '标题和内容不能为空');
    if (!input.recipients.length) throw httpError(400, '请至少选择一个收件人');
    const config = getConfig(store, appKey);
    const wechatTemplateId = validateWechatTemplateId(input.wechatTemplateId || config.templateId);
    const wechatData = validateWechatData(input.wechatData, title, content);
    const publicId = randomBytes(16).toString('hex');
    const id = store.addMessage({ publicId, title, content, recipients: input.recipients, wechatTemplateId, wechatData, status: 'sending', source: input.source });
    try {
      if (!config.appid || !config.secret || !wechatTemplateId) throw new Error('微信配置不完整，请先在系统设置中填写');
      const detailUrl = buildDetailUrl(config.baseUrl, publicId);
      const results = await sendWechatMessage({ ...config, templateId: wechatTemplateId }, { title, content, detailUrl, wechatData }, input.recipients, fetchImpl, { maxAttempts: 3, retryDelayMs: options.retryDelayMs });
      const successCount = results.filter(r => r.ok).length;
      const status = successCount === results.length ? 'success' : successCount ? 'partial' : 'failed';
      const attempts = Math.max(...results.map(r=>r.attempts||1),1);
      const error = results.filter(r => !r.ok).map(r => `${maskOpenid(r.openid)}: ${r.error}${r.errcode?` (${r.errcode})`:''}`).join('; ');
      store.updateMessage(id,{successCount,status,error,attempts});
      return { id, publicId, status, successCount, total: results.length, attempts, error: error || undefined };
    } catch (error) {
      store.updateMessage(id,{successCount:0,status:'failed',error:error.message,attempts:1});
      throw error;
    }
  }

  async function runDueSchedules() {
    for (const schedule of store.dueSchedules(new Date().toISOString())) {
      const next = nextScheduleRun(schedule);
      store.updateScheduleRun(schedule.id,{enabled:next.enabled,nextRunAt:next.at,status:'running'});
      try {
        const result = await dispatchMessage({title:schedule.title,content:schedule.content,recipients:resolveScheduleRecipients(schedule),wechatTemplateId:schedule.wechat_template_id,wechatData:schedule.wechat_data,source:'schedule'});
        store.updateScheduleRun(schedule.id,{enabled:next.enabled,nextRunAt:next.at,status:result.status,error:result.error});
      } catch (error) { store.updateScheduleRun(schedule.id,{enabled:next.enabled,nextRunAt:next.at,status:'failed',error:error.message}); }
    }
  }

  function resolveScheduleRecipients(schedule) {
    if(schedule.send_all)return store.enabledOpenids();
    return schedule.recipient_ids.map(id=>store.getRecipient(Number(id))).filter(r=>r?.enabled).map(r=>r.openid);
  }

  return { server, store, runDueSchedules };
}

function seedSettings(store, env) {
  const values = { wx_appid: env.WX_APPID, wx_template_id: env.WX_TEMPLATE_ID, wx_base_url: env.WX_BASE_URL };
  for (const [key, value] of Object.entries(values)) if (value && !store.getSetting(key)) store.setSetting(key, value);
  if (env.WX_SECRET && !store.getSetting('wx_secret')) store.setSetting('wx_secret', encrypt(env.WX_SECRET, env.APP_KEY || 'wxpush-local-development-key'));
  if (env.API_TOKEN && !store.getSetting('api_token_hash')) store.setSetting('api_token_hash', hashToken(env.API_TOKEN));
  if (env.WX_USERID && !store.listRecipients().length) {
    for (const [index, openid] of env.WX_USERID.split('|').map(v => v.trim()).filter(Boolean).entries()) store.addRecipient({ name: `默认用户 ${index + 1}`, openid });
  }
}

function getConfig(store, appKey) {
  const encrypted = store.getSetting('wx_secret');
  let secret = '';
  try { secret = encrypted ? decrypt(encrypted, appKey) : ''; } catch { secret = ''; }
  const config = { appid: store.getSetting('wx_appid'), secret, templateId: store.getSetting('wx_template_id'), baseUrl: store.getSetting('wx_base_url') };
  return { ...config, configured: Boolean(config.appid && config.secret && config.templateId) };
}

function resolveRecipients(body, store) {
  if (body.all) return store.enabledOpenids();
  const ids = Array.isArray(body.recipientIds) ? body.recipientIds.map(Number) : [];
  return ids.map(id => store.getRecipient(id)).filter(r => r?.enabled).map(r => r.openid);
}

function validateRecipient(body) {
  const item = { name: String(body.name || '').trim(), openid: String(body.openid || '').trim(), group_name: String(body.group_name || '默认分组').trim(), enabled: body.enabled !== false };
  if (!item.name || !item.openid) throw httpError(400, '名称和 OpenID 不能为空');
  if (item.name.length > 80 || item.openid.length > 160 || item.group_name.length > 80) throw httpError(400, '字段长度超出限制');
  return item;
}

function validateTemplate(body){const item={name:String(body.name||'').trim(),title:String(body.title||'').trim(),content:String(body.content||'').trim(),wechatTemplateId:body.wechatTemplateId?validateWechatTemplateId(body.wechatTemplateId):'',wechatData:validateWechatData(body.wechatData,String(body.title||''),String(body.content||''),true)};if(!item.name||!item.title||!item.content)throw httpError(400,'模板名称、标题和内容不能为空');if(item.name.length>80||item.title.length>80||item.content.length>2000)throw httpError(400,'模板内容超出长度限制');return item;}
function validateSchedule(body){const recurrence=['once','daily','weekly'].includes(body.recurrence)?body.recurrence:'once';const date=new Date(body.nextRunAt);if(!String(body.name||'').trim()||!String(body.title||'').trim()||!String(body.content||'').trim())throw httpError(400,'任务名称、标题和内容不能为空');if(Number.isNaN(date.getTime()))throw httpError(400,'请选择有效的发送时间');return{name:String(body.name).trim(),title:String(body.title).trim(),content:String(body.content).trim(),recipientIds:[...new Set(Array.isArray(body.recipientIds)?body.recipientIds.map(Number).filter(Number.isSafeInteger):[])],sendAll:body.sendAll!==false,recurrence,nextRunAt:date.toISOString(),enabled:body.enabled!==false,wechatTemplateId:body.wechatTemplateId?validateWechatTemplateId(body.wechatTemplateId):'',wechatData:validateWechatData(body.wechatData,String(body.title||''),String(body.content||''),true)};}
function nextScheduleRun(schedule){if(schedule.recurrence==='once')return{enabled:false,at:schedule.next_run_at};const date=new Date(schedule.next_run_at),step=schedule.recurrence==='weekly'?7:1;do{date.setUTCDate(date.getUTCDate()+step);}while(date<=new Date());return{enabled:true,at:date.toISOString()};}
function buildDetailUrl(baseUrl,publicId){const base=String(baseUrl||'').replace(/\/+$/,'');if(!base)return'';return `${base.endsWith('/detail')?base:`${base}/detail`}/${publicId}`;}
function validateWechatTemplateId(value){const id=String(value||'').trim();if(!id||id.length>160)throw httpError(400,'微信模板 ID 无效');return id;}
function validateWechatData(input,title,content,allowEmpty=false){if(input===undefined||input===null||input==='')return allowEmpty?{}:{title:{value:title},content:{value:content}};let raw=input;if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch{throw httpError(400,'微信模板字段 data 必须是有效 JSON');}}if(!raw||typeof raw!=='object'||Array.isArray(raw))throw httpError(400,'微信模板字段 data 格式不正确');const entries=Object.entries(raw);if(entries.length>20)throw httpError(400,'微信模板字段最多 20 项');const result={};for(const[key,item]of entries){if(!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))throw httpError(400,`微信模板字段名无效：${key}`);const value=String(typeof item==='object'&&item!==null?item.value??'':item??'');if(value.length>2000)throw httpError(400,`微信模板字段 ${key} 内容过长`);const color=typeof item==='object'&&item!==null?String(item.color||'').trim():'';if(color&&!/^#[0-9a-f]{6}$/i.test(color))throw httpError(400,`微信模板字段 ${key} 颜色格式错误`);result[key]=color?{value,color}:{value};}return Object.keys(result).length||allowEmpty?result:{title:{value:title},content:{value:content}};}

function serveDetail(res,message){if(!message){res.writeHead(404,{'content-type':'text/html; charset=utf-8'});return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>消息不存在</title><body><main><h1>消息不存在或已被删除</h1></main></body></html>');}const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(message.title)} · WXPush</title><link rel="stylesheet" href="/detail.css"></head><body><main><div class="brand"><span></span>WXPush</div><article><p class="eyebrow">MESSAGE DETAIL</p><h1>${escapeHtml(message.title)}</h1><div class="meta"><span>${formatBeijing(message.created_at)}</span><b>${message.status==='success'?'已送达':'通知消息'}</b></div><div class="content">${escapeHtml(message.content)}</div></article><footer>由 WXPush 私有消息服务安全送达</footer></main></body></html>`;res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'private, max-age=60'});res.end(html);}
function serveCsv(res,messages){const rows=[['ID','标题','内容','接收数','成功数','状态','来源','发送时间'],...messages.map(m=>[m.id,m.title,m.content,m.recipient_count,m.success_count,m.status,m.source,m.created_at])];const csv='\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="wxpush-messages-${new Date().toISOString().slice(0,10)}.csv"`});res.end(csv);}
function csvCell(value){return `"${String(value??'').replace(/"/g,'""')}"`;}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function formatBeijing(value){try{return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'long',timeStyle:'short'}).format(new Date(`${String(value).replace(' ','T')}Z`));}catch{return String(value||'');}}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(PUBLIC_DIR, requested);
  if (!target.startsWith(PUBLIC_DIR) || !existsSync(target)) {
    if (!extname(pathname)) return serveFile(req, res, resolve(PUBLIC_DIR, 'index.html'));
    return json(res, 404, { error: 'Not found' });
  }
  return serveFile(req, res, target);
}

async function serveFile(req, res, target) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  const content = await readFile(target);
  res.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : content);
}

function requireSession(req, store) {
  const raw = parseCookies(req.headers.cookie || '').wxpush_session;
  const hash = raw ? hashToken(raw) : '';
  return hash && store.hasSession(hash, Date.now()) ? hash : '';
}

function parseCookies(value) { return Object.fromEntries(value.split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2)); }
function hashToken(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }
function safeHashEqual(a, b) { if (!a || !b || a.length !== b.length) return false; return timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function maskOpenid(value) { return value.length < 9 ? '***' : `${value.slice(0, 4)}…${value.slice(-4)}`; }
function parseRecipientSelector(value) { return (Array.isArray(value) ? value : String(value || '').split('|')).map(item => String(item).trim()).filter(Boolean); }
function verifySmsForwarderSignature(timestampValue, signValue, secret, store) {
  const timestamp = String(timestampValue || '').trim();
  const timestampMs = Number(timestamp);
  if (!timestamp || !Number.isSafeInteger(timestampMs)) return { ok: false, error: 'Invalid timestamp' };
  const now = Date.now();
  if (Math.abs(now - timestampMs) > SIGN_MAX_SKEW_MS) return { ok: false, error: 'Timestamp expired' };
  const supplied = decodeApiSignature(signValue);
  if (!supplied) return { ok: false, error: 'Missing sign' };
  const expected = createHmac('sha256', secret).update(`${timestamp}\n${secret}`, 'utf8').digest('base64');
  if (!safeTextEqual(expected, supplied)) return { ok: false, error: 'Invalid sign' };
  const signatureHash = createHash('sha256').update(`${timestamp}\n${supplied}`).digest('hex');
  if (!store.rememberApiSignature(signatureHash, timestampMs + SIGN_MAX_SKEW_MS, now)) return { ok: false, error: 'Replay request rejected' };
  return { ok: true };
}
function decodeApiSignature(value) { const raw=String(value||'').trim();try{return /%[0-9a-f]{2}/i.test(raw)?decodeURIComponent(raw):raw;}catch{return raw;} }
function safeTextEqual(a,b){const left=Buffer.from(String(a));const right=Buffer.from(String(b));return left.length===right.length&&timingSafeEqual(left,right);}
function isWrite(method) { return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method); }
function validOrigin(req) { const origin = req.headers.origin; if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } }
function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }

async function readJson(req, lenient = false) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > JSON_LIMIT) throw httpError(413, '请求体过大'); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { if (lenient) return Object.fromEntries(new URLSearchParams(raw)); throw httpError(400, 'JSON 格式不正确'); }
}

function json(res, status, value) { if (res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function setSecurityHeaders(res) { res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"); }

function encrypt(value, key) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decrypt(value, key) {
  const [iv, tag, encrypted] = value.split('.').map(v => Buffer.from(v, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3939);
  const { server } = createApp();
  server.listen(port, '0.0.0.0', () => console.log(`WXPush 管理后台已启动：http://localhost:${port}`));
}
