# 急诊抢救记录单微信跨系统导出包

本包将抢救记录单保留为静态填写页面，并增加 Cloudflare Worker + 私有 R2 的临时导出服务。页面在微信中生成 PNG 归档页后上传服务端，由服务端生成 PDF，再返回 HTTPS 文件链接。

## 交付结构

- `docs/emergency-rescue.html`：原抢救记录单填写页，已支持微信导出服务。
- `docs/export-config.js`：填写 Worker 的 HTTPS 地址。
- `docs/微信入口.html`：可作为微信分享入口，自动打开抢救记录单。
- `worker/`：Cloudflare Worker、R2 配置和 PDF 生成服务。

## 部署步骤

1. 在 Cloudflare 账户中登录 Wrangler：

   ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler r2 bucket create emergency-rescue-export
   ```

2. 编辑 `worker/wrangler.toml`：

   - `bucket_name` 必须与实际创建的 R2 Bucket 一致。
   - `ALLOWED_ORIGINS` 改为部署网页的 HTTPS 域名，例如 `https://xiaobangcc006-star.github.io`。
   - 如有多个网页域名，用英文逗号分隔。

3. 发布导出服务：

   ```bash
   npm run deploy
   ```

   记录输出的 Worker HTTPS 地址，例如：

   ```text
   https://emergency-rescue-wechat-export.example.workers.dev
   ```

4. 编辑 `docs/export-config.js`，将 `apiBaseUrl` 改为上一步的 Worker HTTPS 地址。

5. 将 `docs/` 目录部署至 GitHub Pages、Cloudflare Pages 或任意 HTTPS 静态网站。微信分享链接应指向：

   ```text
   https://你的域名/微信入口.html
   ```

6. 用浏览器检查服务：

   ```bash
   curl https://你的-worker域名/health
   ```

   返回 `{"ok":true,"service":"emergency-rescue-export"}` 后，再从微信打开网页测试导出。

## 微信端行为

- Android 微信：导出后可点"下载PDF"或"打开PDF预览"；图片页可打开后长按保存。
- iPhone 微信：PDF 使用微信文档预览器打开，用户通过右上角保存、转发或在浏览器中打开；图片页可长按保存。
- 普通浏览器：保留 PNG/PDF 标准下载按钮。
- 本地 `file:///` 打开：不上传病历内容，自动回退到原有 Canvas 本地预览。

## 数据与安全

- R2 Bucket 必须保持私有，文件仅通过 Worker 返回。
- 导出链接使用随机 UUID，文件默认 30 分钟失效；Worker 每 5 分钟清理过期文件。
- 服务端不记录请求正文、患者信息或病历文本日志。
- 部署时应确保 `ALLOWED_ORIGINS` 仅包含本院实际使用的 HTTPS 域名。

## 上线前验收

1. 在 Android 微信、iPhone 微信、Chrome/Safari 中分别导出单页和多页记录。
2. 确认图片在微信中打开后能长按保存，PDF 能打开预览。
3. 等待超过 30 分钟后确认旧链接返回"导出文件已过期"。
4. 对比导出图片与当前 A4 黑白模板，确认院徽、医院名称、表格线和分页未改变。
