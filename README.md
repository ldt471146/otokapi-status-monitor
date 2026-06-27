# OpenToken Status Monitor

GitHub Pages 静态监控页，用 GitHub Actions 定时抓取 `https://otokapi.com/monitor` 背后的接口，展示订阅、用量和渠道状态。

## 部署方式

1. 登录 `https://otokapi.com`。
2. 打开浏览器 DevTools Console，复制 refresh token：

```js
copy(localStorage.getItem('refresh_token'))
```

3. 在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 添加 Secret：

```text
OTOKAPI_REFRESH_TOKEN=<上一步复制的值>
```

也可以用短期 access token：

```js
copy(localStorage.getItem('auth_token'))
```

然后把它保存为 `OTOKAPI_BEARER_TOKEN`。access token 可能过期，长期运行优先用 `OTOKAPI_REFRESH_TOKEN`。

4. 打开 `Actions -> Update OpenToken status and deploy Pages -> Run workflow` 手动触发一次。

## 安全边界

- token 只在 GitHub Actions 里作为 Secret 使用，不会写入前端页面。
- `public/data/status.json` 是部署到 Pages 的展示数据，任何能访问 Pages 的人都能看到里面的订阅余量、用量数字和渠道状态。
- 如果这些数据不适合公开，请保持仓库私有并确认 GitHub Pages 的访问策略，或改用私有服务器/Cloudflare Worker 做鉴权展示。

## 实时性说明

GitHub Pages 是静态站，不能安全地在浏览器里直接请求带 token 的 OpenToken API。本项目采用安全的近实时方案：

- GitHub Actions 每 5 分钟抓取一次最新状态。
- 页面每 30 秒重新读取 `data/status.json`。
- 如果需要 30 秒级真正实时，需要部署一个带鉴权的后端代理。

## 本地测试

```bash
npm test
npm run fetch
python -m http.server 4173 -d public
```

然后打开 `http://127.0.0.1:4173`。

