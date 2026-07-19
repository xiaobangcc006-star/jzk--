# 急诊抢救记录单 GitHub + 微信导出部署包

该仓库可以直接部署到 GitHub Pages。GitHub Pages 负责 HTTPS 填写页面，Cloudflare Worker + 私有 R2 负责微信中的临时 PNG/PDF 文件服务。

## 目录说明

- `docs/`：GitHub Pages 静态站点目录。根地址会自动打开 `emergency-rescue.html`。
- `docs/export-config.js`：填写 Cloudflare Worker 的 HTTPS 地址。
- `.github/workflows/deploy-pages.yml`：推送 `main` 后自动发布 GitHub Pages。
- `.github/workflows/deploy-worker.yml`：从 GitHub Actions 手动发布 Cloudflare Worker。
- `worker/`：Cloudflare Worker、R2 配置和 PDF 生成服务。

## 第一次部署

### 1. 推送到 GitHub

当前目录已经是 Git 仓库。确认远程仓库后执行：

```bash
git add .
git commit -m "Configure GitHub Pages deployment"
git push origin main
```

进入 GitHub 仓库的 **Settings → Pages**，将 Source 设为 **GitHub Actions**。首次工作流完成后，页面地址通常为：

```text
https://<GitHub用户名>.github.io/<仓库名>/
```

不要把 `docs/` 单独上传到仓库根目录；必须保留本仓库的完整目录结构和 `.github/workflows/`。

### 2. 创建 R2 Bucket 并配置 Worker

在本机执行：

```bash
cd worker
npm install
npx wrangler login
npx wrangler r2 bucket create emergency-rescue-export
```

编辑 `worker/wrangler.toml`：

- `bucket_name` 改成实际 R2 Bucket 名称。
- `ALLOWED_ORIGINS` 改成 Pages 的来源，只写协议和域名，例如 `https://xiaobangcc006-star.github.io`，不要加仓库路径。

本机发布：

```bash
npm run deploy
```

也可使用仓库 Actions 发布：在 GitHub **Settings → Secrets and variables → Actions** 添加 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`，随后在 **Actions → Deploy Cloudflare export Worker → Run workflow** 运行。

### 3. 连接网页与 Worker

将 Worker 发布后得到的 HTTPS 地址填入 `docs/export-config.js`：

```js
window.EMERGENCY_EXPORT_CONFIG = {
  apiBaseUrl: "https://emergency-rescue-wechat-export.<你的子域>.workers.dev",
  timeoutMs: 90000
};
```

提交并推送该改动，GitHub Pages 会自动更新：

```bash
git add docs/export-config.js
git commit -m "Configure emergency export endpoint"
git push origin main
```

浏览器访问 `https://<Worker地址>/health`，返回 `{"ok":true,"service":"emergency-rescue-export"}` 后即可在微信中测试。

## 微信端导出方式

- Android 微信：可打开 PDF 预览或下载；图片页可打开后长按保存。
- iPhone 微信：使用微信文档预览 PDF，用户可通过右上角保存、转发或在浏览器中打开；图片可长按保存。
- 普通浏览器：保留 PNG/PDF 标准下载按钮。
- 本地 `file:///`：仅保留本地 Canvas 预览，不会上传病历数据。

GitHub Pages 是纯静态托管，不能安全地保存病历图片或生成 PDF；因此微信跨系统导出必须保留 Worker/R2 部分。R2 Bucket 保持私有，链接随机且默认 30 分钟过期，Worker 不记录病历正文日志。

## 发布后验收

1. GitHub Pages 根地址应直接进入急诊抢救记录单。
2. Android 微信、iPhone 微信、Chrome/Safari 分别导出单页和多页记录。
3. 图片在微信中打开后能长按保存，PDF 能在微信文档预览器中打开。
4. 等待 30 分钟后，旧链接应返回“导出文件已过期”。
5. 对比导出图片与原 A4 黑白模板，确认院徽、医院名称、表格线和分页没有变化。
