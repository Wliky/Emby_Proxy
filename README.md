# Emby Proxy (Cloudflare Worker)
Emby通用反代及前后端分离自动反代

## ✨通用反代 (emby-cf-auto-proxy.js)
- 即用型代理：访问自定义域名/你的-emby-域名，即可代理任何 Emby 服务器。

## ✨前后端分离反代 (emby-cf-proxy.js)
- 前后端代理：需要在代码填写前端登录域名，后端推流地址自动转发。

## 🌟 核心特性
- 🚀 智能缓存：图片资源边缘节点缓存，大幅提升封面加载速度
- 🛡️ 特征隐藏：清除 Cloudflare 追踪头，避免 Emby 识别拦截
- 🎬 流媒体优化：视频流零缓存透传，WebSocket 直通，跑满带宽

## 🚀 快速部署
- 部署到 Cloudflare Worker
- 打开 Cloudflare Dashboard → 选择你的域名 → Workers & Pages → 创建应用程序 → 创建 Worker
- 删除默认代码，粘贴本项目完整代码
- 点击 保存并部署，记录分配的 Worker 域名（如 xxx.xxx.workers.dev）
