/*
 * 微信导出服务配置。
 * 部署 Worker 后，将 apiBaseUrl 改成实际的 HTTPS 地址，例如：
 * https://emergency-rescue-export.example.workers.dev
 *
 * GitHub Pages 发布前请提交本文件的改动；保持为空时，页面仍可在普通浏览器中
 * 生成本地预览，但微信内不会上传临时文件。
 */
window.EMERGENCY_EXPORT_CONFIG = {
  apiBaseUrl: "",
  timeoutMs: 90000
};
