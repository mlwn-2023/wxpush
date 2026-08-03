# WXPush NAS 管理版

基于 [frankiejun/wxpush](https://github.com/frankiejun/wxpush) 改造的微信模板消息自托管服务。新增完整中文管理后台、SQLite 数据持久化、登录认证、收件人管理、推送记录和可视化配置，并保留原 `/wxsend` GET/POST API。

## 功能

- 响应式中文管理后台：总览、消息编辑与微信预览
- 适配“推送通知”模板的标题、详情和北京时间字段
- 收件人分组、启停、搜索与完整 CRUD
- 推送历史、记录删除、成功率与服务健康状态
- 单次、每天、每周定时发送，支持立即执行
- 独立移动端消息详情页
- 失败自动重试与历史消息手动重发
- 常用消息模板和发送页一键套用
- 多调用方 API Token，可独立启停与撤销
- SQLite 备份、CSV 导出和历史自动清理
- 微信 AppSecret 使用 AES-256-GCM 加密落盘
- 管理员会话、HttpOnly Cookie、来源校验与安全响应头
- 兼容 Bearer Token 和原 URL Token 调用方式
- 单容器运行，SQLite 数据目录可直接备份

## 本地运行

要求 Node.js 22.5 或更高版本（推荐 Node.js 24）。项目没有第三方 npm 依赖。

```bash
cp .env.example .env
# 按需设置环境变量后：
npm start
```

开发环境未设置变量时，可使用：

- 地址：`http://localhost:3939`
- 用户名：`admin`
- 密码：`wxpush123456`
- API Token：`wxpush-local-token`

这些仅是本地开发默认值。`NODE_ENV=production` 时，服务会强制要求安全的 `ADMIN_PASSWORD`、`APP_KEY` 与 `API_TOKEN`。

## 测试

```bash
npm test
```

测试覆盖健康检查、静态管理台、登录鉴权、收件人 CRUD、微信配置、消息推送和原 API 兼容性；微信请求在测试中使用本地模拟，不会发送真实消息。

## API

完整的认证方式、请求参数、响应说明和全部管理接口见 [后端 API 文档](docs/API.md)。

推荐使用 POST：

```bash
curl -X POST "http://localhost:3939/wxsend" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timestamp":"MILLISECOND_TIMESTAMP","sign":"SMSFORWARDER_SIGN","title":"服务器通知","content":"备份任务已完成"}'
```

生产环境默认要求 SmsForwarder 兼容签名：以 API Token 作为 `secret`，计算 `HMAC-SHA256(timestamp + "\n" + secret)`，再进行 Base64 和 URL 编码。服务同时校验一小时时间窗口，并在 SQLite 中拒绝已使用签名。完整计算示例见 [后端 API 文档](docs/API.md)。

兼容原 GET 调用：

```text
/wxsend?token=YOUR_API_TOKEN&timestamp=MILLISECOND_TIMESTAMP&sign=URL_ENCODED_SIGN&title=服务器通知&content=备份完成
```

推荐传 `group=服务器告警` 按后台收件人分类发送；多个分类可用 `group=服务器告警|家庭通知`，POST JSON 也可传 `groups: ["服务器告警", "家庭通知"]`。仍可传 `userid=OPENID1|OPENID2` 临时覆盖分类和后台启用的收件人。

## 飞牛 NAS 部署准备

1. 将整个项目目录上传到 NAS。
2. 复制 `.env.example` 为 `.env`，至少修改 `ADMIN_PASSWORD`、`APP_KEY` 和 `API_TOKEN`。
3. 在项目目录执行 `docker compose up -d --build`，或在飞牛 Docker Compose 界面导入 `docker-compose.yml`。
4. 打开 `http://NAS_IP:3939`，登录后在“系统设置”填写微信配置。
5. 将 `data` 目录纳入 NAS 备份计划。

正式部署前，建议为管理后台配置 HTTPS 反向代理，不要直接把 3939 端口暴露到公网。

## 数据与升级

所有业务数据保存在 `data/wxpush.db`。升级前备份 `data` 目录，替换代码或镜像后重新启动即可。`APP_KEY` 用于解密 AppSecret，必须长期保存且不能随意更换。

数据库采用兼容式自动迁移。升级到 2.1 后会保留已有配置、收件人和推送记录，并新增模板、定时任务与多 Token 数据表。

## 开源许可

沿用原项目 MIT License。
