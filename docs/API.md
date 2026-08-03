# WXPush 后端 API 文档

本文档对应 WXPush NAS 2.2.2。示例地址为 `http://192.168.6.123:3939`，请替换成实际服务地址。

## 认证方式

### 推送接口 Token

`/wxsend` 推荐使用 Bearer Token：

```http
Authorization: Bearer YOUR_API_TOKEN
```

Token 可以是 `.env` 中的 `API_TOKEN`，也可以是在后台“API Token”菜单创建的独立 Token。为兼容旧调用，也支持 URL 参数 `token=YOUR_API_TOKEN`，但不推荐，因为 Token 可能进入浏览器历史和访问日志。

生产环境默认同时要求 SmsForwarder 兼容签名，并直接以本次请求使用的 API Token 作为签名 `secret`。签名算法为：

1. 生成当前 Unix 毫秒时间戳 `timestamp`。
2. 待签名字符串为 `timestamp + "\n" + secret`。
3. 使用 `secret` 作为密钥计算 HMAC-SHA256。
4. 对结果进行 Base64，再对签名值进行 URL 编码。

服务允许请求时间与服务器时间最多相差一小时，并把已接受签名的哈希写入 SQLite；相同签名在有效期内再次提交会返回 `403 Replay request rejected`。如需临时兼容旧调用，可设置 `REQUIRE_API_SIGN=false`，但不建议长期关闭。

SmsForwarder 的兼容算法只签名时间戳，不覆盖消息正文；跨公网调用仍必须使用 HTTPS，防止 Token、签名和消息内容被窃听或篡改。

### 管理接口会话

`/api/*` 管理接口使用登录后返回的 `wxpush_session` HttpOnly Cookie。除登录接口外都需要携带该 Cookie；POST、PUT、PATCH、DELETE 请求还会校验 `Origin` 与当前 Host 是否一致。

## 消息推送

### `POST /wxsend`

发送微信模板消息，并自动写入推送记录。当前适配的“推送通知”模板字段为 `title`、`content` 和 `time`；调用方只需传标题和详情，`time` 由服务端自动填写为北京时间。

请求头：

```http
Authorization: Bearer YOUR_API_TOKEN
Content-Type: application/json
```

请求参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 条件必填 | 消息标题；SmsForwarder 传入 `from` 时可省略 |
| `content` | string | 是 | 消息正文 |
| `timestamp` | string / number | 是 | 当前 Unix 毫秒时间戳 |
| `sign` | string | 是 | SmsForwarder 规则生成的签名；JSON 可传 Base64 原值或 URL 编码值 |
| `group` | string | 否 | 收件人分类；多个分类使用 `|` 分隔 |
| `groups` | string[] | 否 | 多个收件人分类，仅 POST JSON 支持数组形式 |
| `group_name` | string | 否 | `group` 的兼容别名 |
| `userid` | string | 否 | 一个或多个微信 OpenID，多个使用 `|` 分隔 |

收件人选择优先级：

1. 传入 `userid`：仅发送给这些 OpenID。
2. 未传 `userid`，但传入 `group`、`groups` 或 `group_name`：发送给匹配分类中的所有已启用联系人。
3. 均未传入：发送给后台全部已启用联系人。

分类名称必须与后台保存的名称完全一致。多个分类中出现同一 OpenID 时，由于 OpenID 在联系人表中唯一，不会重复发送。分类不存在或分类中没有启用联系人时返回 `400`。

按单个分类发送：

```json
{
  "timestamp": "1785686400000",
  "sign": "BASE64_OR_URL_ENCODED_SIGN",
  "group": "服务器告警",
  "title": "磁盘告警",
  "content": "剩余空间不足 10%"
}
```

按多个分类发送：

```json
{
  "timestamp": "1785686400000",
  "sign": "BASE64_OR_URL_ENCODED_SIGN",
  "groups": ["服务器告警", "管理员"],
  "title": "服务通知",
  "content": "服务已经恢复"
}
```

指定 OpenID 发送：

```json
{
  "timestamp": "1785686400000",
  "sign": "BASE64_OR_URL_ENCODED_SIGN",
  "userid": "OPENID_1|OPENID_2",
  "title": "个人通知",
  "content": "任务已经完成"
}
```

成功响应：

```json
{
  "msg": "Successfully sent messages to 2 user(s)."
}
```

### `GET /wxsend`

兼容旧版调用。参数通过查询字符串传递，多个分类或 OpenID 使用 `|` 分隔：

```text
/wxsend?token=YOUR_API_TOKEN&timestamp=MILLISECOND_TIMESTAMP&sign=URL_ENCODED_SIGN&group=服务器告警|管理员&title=系统通知&content=更新完成
```

生产环境建议使用 POST，避免 Token 和消息正文出现在 URL 中。

### SmsForwarder 对接

在 SmsForwarder 的 Webhook 发送通道中：

- WebServer：`http://NAS_IP:3939/wxsend?token=YOUR_API_TOKEN&group=服务器告警`
- secret：填写同一个 `YOUR_API_TOKEN`
- 请求方式：GET 或 POST 均可，推荐 POST

SmsForwarder 默认提交的 `from` 会在没有 `title` 时作为消息标题，`content` 作为消息正文；其 `timestamp` 和 `sign` 可被 WXPush 直接验证，无需转换。

## 公共接口

### `GET /health`

服务健康检查，不需要认证。

```json
{
  "ok": true,
  "service": "wxpush",
  "time": "2026-08-03T00:00:00.000Z"
}
```

### `GET /detail/{publicId}`

微信消息详情页，不需要登录。`publicId` 是发送成功后生成的消息公开标识。

## 登录与会话

### `POST /api/auth/login`

```json
{
  "username": "admin",
  "password": "YOUR_ADMIN_PASSWORD"
}
```

成功后响应头写入 `wxpush_session` Cookie。连续登录失败达到限制后会暂时返回 `429`。

### `GET /api/auth/me`

返回当前管理员用户名。

### `POST /api/auth/logout`

注销当前会话并清除 Cookie。

## 仪表盘

### `GET /api/dashboard`

返回消息总数、成功数、失败数、今日发送数、启用联系人数量、最近消息以及微信配置状态。

## 收件人

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/recipients` | 获取全部联系人 |
| POST | `/api/recipients` | 新建联系人 |
| PUT | `/api/recipients/{id}` | 更新联系人 |
| DELETE | `/api/recipients/{id}` | 删除联系人 |

新增或更新请求：

```json
{
  "name": "张三",
  "openid": "WECHAT_OPENID",
  "group_name": "服务器告警",
  "enabled": true
}
```

`openid` 必须唯一，`enabled=false` 的联系人不会被全部发送、分类发送或定时任务选中。

## 消息与推送记录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/messages?limit=100` | 获取推送记录，`limit` 范围为 1–500 |
| POST | `/api/messages/send` | 从管理后台发送消息 |
| POST | `/api/messages/{id}/retry` | 重试一条历史消息 |
| DELETE | `/api/messages/{id}` | 删除单条记录 |
| DELETE | `/api/messages` | 批量删除或全部删除 |

后台发送请求使用联系人数据库 ID：

```json
{
  "title": "系统通知",
  "content": "备份已经完成",
  "recipientIds": [1, 2]
}
```

发送给全部已启用联系人时传入：

```json
{
  "title": "系统通知",
  "content": "备份已经完成",
  "all": true
}
```

批量删除：

```json
{
  "ids": [1, 2, 3]
}
```

全部删除：

```json
{
  "all": true
}
```

## 消息模板

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/templates` | 获取模板列表 |
| POST | `/api/templates` | 新建模板 |
| PUT | `/api/templates/{id}` | 更新模板 |
| DELETE | `/api/templates/{id}` | 删除模板 |

新增或更新请求：

```json
{
  "name": "NAS 告警",
  "title": "磁盘空间告警",
  "content": "剩余空间不足"
}
```

## API Token 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tokens` | 获取 Token 列表，仅返回前缀，不返回原文 |
| POST | `/api/tokens` | 创建 Token，原文只在本次响应中返回 |
| PATCH | `/api/tokens/{id}` | 启用或停用 Token |
| DELETE | `/api/tokens/{id}` | 撤销 Token |

创建 Token：

```json
{
  "name": "Home Assistant"
}
```

启用或停用：

```json
{
  "enabled": false
}
```

## 定时任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/schedules` | 获取定时任务列表 |
| POST | `/api/schedules` | 新建定时任务 |
| PUT | `/api/schedules/{id}` | 更新定时任务 |
| POST | `/api/schedules/{id}/run` | 立即执行，不改变下次计划时间 |
| DELETE | `/api/schedules/{id}` | 删除定时任务 |

请求示例：

```json
{
  "name": "每日状态通知",
  "title": "NAS 每日报告",
  "content": "设备运行正常",
  "recipientIds": [1, 2],
  "sendAll": false,
  "recurrence": "daily",
  "nextRunAt": "2026-08-04T01:00:00.000Z",
  "enabled": true
}
```

`recurrence` 支持 `once`、`daily` 和 `weekly`。时间使用 ISO 8601；后端以 UTC 保存，管理界面按浏览器本地时区展示。

## 设置与微信连通性

### `GET /api/settings`

返回 AppID、模板 ID、详情基础地址、历史保留天数以及 AppSecret 是否已经设置。不会返回 AppSecret 原文。

### `PUT /api/settings`

仅传需要修改的字段：

```json
{
  "appid": "wx123456",
  "secret": "WECHAT_APP_SECRET",
  "templateId": "TEMPLATE_ID",
  "baseUrl": "https://push.example.com/detail",
  "apiToken": "OPTIONAL_LEGACY_TOKEN",
  "retentionDays": 90
}
```

AppSecret 使用 AES-256-GCM 加密保存。`baseUrl` 应填写详情页基础地址，服务会自动拼接消息 `publicId`。

### `POST /api/settings/test`

测试微信 AppID 与 AppSecret 是否能取得 access token。请求体可以为空以测试已保存配置，也可以临时传入 `appid` 和 `secret`。

## 数据维护

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/data/messages.csv` | 导出全部推送记录 CSV |
| GET | `/api/data/backup` | 下载 SQLite 数据库备份 |
| POST | `/api/data/cleanup` | 按设置中的保留天数清理旧记录 |

## 常见状态码

| 状态码 | 说明 |
| --- | --- |
| 200 / 201 | 请求成功或资源创建成功 |
| 400 | 参数缺失、没有匹配的收件人或格式错误 |
| 401 | 管理会话缺失或过期 |
| 403 | API Token 无效或请求来源校验失败 |
| 404 | 资源不存在 |
| 409 | OpenID 等唯一字段冲突 |
| 429 | 登录尝试过多 |
| 502 | 微信接口调用失败或消息全部发送失败 |

## PowerShell 分类推送示例

```powershell
$headers = @{ Authorization = "Bearer YOUR_API_TOKEN" }
$token = "YOUR_API_TOKEN"
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$hmac = [System.Security.Cryptography.HMACSHA256]::new(
    [System.Text.Encoding]::UTF8.GetBytes($token)
)
$signBytes = $hmac.ComputeHash(
    [System.Text.Encoding]::UTF8.GetBytes("$timestamp`n$token")
)
$sign = [Convert]::ToBase64String($signBytes)
$hmac.Dispose()
$body = @{
    timestamp = $timestamp
    sign = $sign
    group = "服务器告警"
    title = "磁盘告警"
    content = "剩余空间不足 10%"
} | ConvertTo-Json

Invoke-RestMethod `
    -Uri "http://192.168.6.123:3939/wxsend" `
    -Method Post `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $body
```
