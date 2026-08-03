import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wxpush-test-'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    if (String(url).includes('stable_token')) return Response.json({ access_token: 'wechat-access-token' });
    return Response.json({ errcode: 0, errmsg: 'ok' });
  };
  const app = createApp({
    dataDir: dir,
    fetchImpl,
    env: { NODE_ENV: 'test', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'strong-password', APP_KEY: 'test-app-key-with-enough-entropy', API_TOKEN: 'test-api-token-123456789', REQUIRE_API_SIGN: 'true' }
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function close() { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
  return { ...app, base, calls, close };
}

async function login(ctx) {
  const response = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'strong-password' }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

function signedPayload(secret, body = {}) {
  const timestamp = String(Date.now());
  const sign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`, 'utf8').digest('base64');
  return { ...body, timestamp, sign };
}

test('health check and static console are available', async t => {
  const ctx = await setup(); t.after(ctx.close);
  const health = await fetch(`${ctx.base}/health`); assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  const page = await fetch(ctx.base); assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /WXPush 管理台/); assert.match(html, /id="scheduleTemplate"/); assert.match(html, /SmsForwarder 配置/); assert.match(html, /timestamp.*sign/s); assert.match(page.headers.get('content-security-policy'), /default-src/);
});

test('login rejects bad credentials and protects API', async t => {
  const ctx = await setup(); t.after(ctx.close);
  const denied = await fetch(`${ctx.base}/api/dashboard`); assert.equal(denied.status, 401);
  const bad = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
  assert.equal(bad.status, 401);
  const cookie = await login(ctx); const dashboard = await fetch(`${ctx.base}/api/dashboard`, { headers: { cookie } }); assert.equal(dashboard.status, 200);
  const missingConfig = await fetch(`${ctx.base}/api/settings/test`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missingConfig.status, 400); assert.match((await missingConfig.json()).error, /AppID/);
  const stillHealthy = await fetch(`${ctx.base}/health`); assert.equal(stillHealthy.status, 200);
});

test('recipient CRUD, settings and console sending work end-to-end', async t => {
  const ctx = await setup(); t.after(ctx.close); const cookie = await login(ctx);
  const headers = { cookie, 'content-type': 'application/json' };
  const create = await fetch(`${ctx.base}/api/recipients`, { method: 'POST', headers, body: JSON.stringify({ name: '测试用户', openid: 'openid-test-user', group_name: '运维' }) });
  assert.equal(create.status, 201); const recipient = (await create.json()).recipient;
  const settings = await fetch(`${ctx.base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ appid: 'wx-app-id', secret: 'wx-secret', templateId: 'template-id', baseUrl: 'https://example.com/detail' }) });
  assert.equal(settings.status, 200);
  const send = await fetch(`${ctx.base}/api/messages/send`, { method: 'POST', headers, body: JSON.stringify({ title: '磁盘告警', content: '磁盘空间低于 10%', recipientIds: [recipient.id] }) });
  assert.equal(send.status, 200); const sent = await send.json(); assert.equal(sent.successCount, 1);
  const messages = await fetch(`${ctx.base}/api/messages`, { headers: { cookie } }); const list = (await messages.json()).messages;
  assert.equal(list.length, 1); assert.equal(list[0].status, 'success'); assert.equal(ctx.calls.length, 2);
  const deleteMessage = await fetch(`${ctx.base}/api/messages/${list[0].id}`, { method: 'DELETE', headers: { cookie } }); assert.equal(deleteMessage.status, 200);
  const afterDelete = await fetch(`${ctx.base}/api/messages`, { headers: { cookie } }); assert.equal((await afterDelete.json()).messages.length, 0);
  const firstId = ctx.store.addMessage({ title: '记录一', content: '测试', recipients: ['openid-test-user'], status: 'success', successCount: 1 });
  ctx.store.addMessage({ title: '记录二', content: '测试', recipients: ['openid-test-user'], status: 'failed' });
  const batchDelete = await fetch(`${ctx.base}/api/messages`, { method: 'DELETE', headers, body: JSON.stringify({ ids: [firstId] }) });
  assert.equal(batchDelete.status, 200); assert.equal((await batchDelete.json()).deleted, 1);
  const deleteAll = await fetch(`${ctx.base}/api/messages`, { method: 'DELETE', headers, body: JSON.stringify({ all: true }) });
  assert.equal(deleteAll.status, 200); assert.equal((await deleteAll.json()).deleted, 1);
  const remove = await fetch(`${ctx.base}/api/recipients/${recipient.id}`, { method: 'DELETE', headers: { cookie } }); assert.equal(remove.status, 200);
});

test('legacy wxsend endpoint remains compatible', async t => {
  const ctx = await setup(); t.after(ctx.close); const cookie = await login(ctx); const headers = { cookie, 'content-type': 'application/json' };
  await fetch(`${ctx.base}/api/recipients`, { method: 'POST', headers, body: JSON.stringify({ name: 'API 用户', openid: 'openid-api-user', group_name: '服务器告警' }) });
  await fetch(`${ctx.base}/api/recipients`, { method: 'POST', headers, body: JSON.stringify({ name: '其他用户', openid: 'openid-other-user', group_name: '家庭通知' }) });
  await fetch(`${ctx.base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ appid: 'appid', secret: 'secret', templateId: 'template' }) });
  const denied = await fetch(`${ctx.base}/wxsend?token=bad&title=a&content=b`); assert.equal(denied.status, 403);
  const unsigned = await fetch(`${ctx.base}/wxsend`, { method: 'POST', headers: { authorization: 'Bearer test-api-token-123456789', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Unsigned', content: '拒绝未签名请求' }) });
  assert.equal(unsigned.status, 403); assert.match((await unsigned.json()).msg, /timestamp/);
  const payload = signedPayload('test-api-token-123456789', { group: '服务器告警', from: 'SmsForwarder', content: '部署完成' });
  const form = new URLSearchParams(payload);
  const response = await fetch(`${ctx.base}/wxsend`, { method: 'POST', headers: { authorization: 'Bearer test-api-token-123456789', 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(response.status, 200); assert.match((await response.json()).msg, /Successfully sent/);
  const wechatPayload = JSON.parse(ctx.calls.at(-1).body); assert.equal(wechatPayload.touser, 'openid-api-user'); assert.equal(wechatPayload.data.title.value, 'SmsForwarder');
  const replay = await fetch(`${ctx.base}/wxsend`, { method: 'POST', headers: { authorization: 'Bearer test-api-token-123456789', 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(replay.status, 403); assert.match((await replay.json()).msg, /Replay/);
});

test('templates, scoped tokens, schedules, detail page and exports work', async t => {
  const ctx = await setup(); t.after(ctx.close); const cookie = await login(ctx); const headers = { cookie, 'content-type': 'application/json' };
  await fetch(`${ctx.base}/api/recipients`, { method: 'POST', headers, body: JSON.stringify({ name: '自动化用户', openid: 'openid-automation' }) });
  await fetch(`${ctx.base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ appid: 'appid', secret: 'secret', templateId: 'template', baseUrl: ctx.base }) });

  const templateCreate = await fetch(`${ctx.base}/api/templates`, { method: 'POST', headers, body: JSON.stringify({ name: 'NAS 告警', title: '磁盘告警', content: '剩余空间不足' }) });
  assert.equal(templateCreate.status, 201); const template = (await templateCreate.json()).template;
  const templateList = await fetch(`${ctx.base}/api/templates`, { headers: { cookie } }); assert.equal((await templateList.json()).templates.length, 1);
  const templateDelete = await fetch(`${ctx.base}/api/templates/${template.id}`, { method: 'DELETE', headers: { cookie } }); assert.equal(templateDelete.status, 200);

  const tokenCreate = await fetch(`${ctx.base}/api/tokens`, { method: 'POST', headers, body: JSON.stringify({ name: 'Home Assistant' }) });
  assert.equal(tokenCreate.status, 201); const generatedToken = (await tokenCreate.json()).token; assert.match(generatedToken, /^wxp_/);
  const tokenSend = await fetch(`${ctx.base}/wxsend`, { method: 'POST', headers: { authorization: `Bearer ${generatedToken}`, 'content-type': 'application/json' }, body: JSON.stringify(signedPayload(generatedToken,{ title: '自动化通知', content: 'Token 调用成功' })) }); assert.equal(tokenSend.status, 200);

  const scheduleCreate = await fetch(`${ctx.base}/api/schedules`, { method: 'POST', headers, body: JSON.stringify({ name: '立即到期任务', title: '定时通知', content: '计划执行成功', sendAll: true, recurrence: 'once', nextRunAt: new Date(Date.now() - 1000).toISOString() }) });
  assert.equal(scheduleCreate.status, 201); await ctx.runDueSchedules();
  const schedules = await fetch(`${ctx.base}/api/schedules`, { headers: { cookie } }); const schedule = (await schedules.json()).schedules[0]; assert.equal(schedule.enabled, false); assert.equal(schedule.last_status, 'success');
  const messages = await fetch(`${ctx.base}/api/messages`, { headers: { cookie } }); const list = (await messages.json()).messages; assert.ok(list.length >= 2);
  const detail = await fetch(`${ctx.base}/detail/${list[0].public_id}`); assert.equal(detail.status, 200); assert.match(await detail.text(), /定时通知/);
  const csv = await fetch(`${ctx.base}/api/data/messages.csv`, { headers: { cookie } }); assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
  const backup = await fetch(`${ctx.base}/api/data/backup`, { headers: { cookie } }); assert.equal(backup.status, 200); assert.ok((await backup.arrayBuffer()).byteLength > 1000);
});
