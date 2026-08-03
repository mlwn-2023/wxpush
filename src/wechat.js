export async function verifyWechat(config, fetchImpl = fetch) {
  const token = await getAccessToken(config, fetchImpl);
  return { ok: Boolean(token), message: token ? '微信接口连接成功' : '未能获取 access_token' };
}

export async function sendWechatMessage(config, message, openids, fetchImpl = fetch, options = {}) {
  const accessToken = await getAccessToken(config, fetchImpl);
  const maxAttempts = Math.min(Math.max(Number(options.maxAttempts) || 3, 1), 3);
  const results = [];
  for (const openid of openids) {
    let last = { openid, ok: false, error: '未知错误', errcode: -1, attempts: 0 };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await sendOne(accessToken, config, message, openid, fetchImpl, attempt);
      if (last.ok || !isRetryable(last.errcode)) break;
      if (attempt < maxAttempts) await delay(options.retryDelayMs ?? attempt * 400);
    }
    results.push(last);
  }
  return results;
}

async function sendOne(accessToken, config, message, openid, fetchImpl, attempt) {
  try {
    const response = await fetchImpl(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ touser: openid, template_id: config.templateId, url: message.detailUrl || '', data: { title: { value: message.title }, content: { value: message.content }, time: { value: formatBeijingTime() } } }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    return { openid, ok: response.ok && data.errcode === 0, error: data.errmsg || (!response.ok ? `HTTP ${response.status}` : ''), errcode: Number(data.errcode || 0), attempts: attempt };
  } catch (error) {
    return { openid, ok: false, error: error.message, errcode: -1, attempts: attempt };
  }
}

async function getAccessToken(config, fetchImpl) {
  if (!config.appid || !config.secret) throw new Error('请先配置微信 AppID 和 AppSecret');
  const response = await fetchImpl('https://api.weixin.qq.com/cgi-bin/stable_token', { method: 'POST', headers: { 'content-type': 'application/json;charset=utf-8' }, body: JSON.stringify({ grant_type: 'client_credential', appid: config.appid, secret: config.secret, force_refresh: false }), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data.errmsg || `微信接口返回 HTTP ${response.status}`);
  return data.access_token;
}

function isRetryable(code) { return [-1, -1_000, 40001, 40014, 42001, 45009].includes(Number(code)); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatBeijingTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
