# Emby Proxy (Cloudflare Worker)
Emby 通用反代及前后端分离自动反代工具，基于 Cloudflare Worker 实现，解决 Emby 服务器地域拦截、访问限制问题，优化流媒体转发体验。

## ✨ 功能分类
### ✨ 通用反代 (emby-cf-auto-proxy.js)
- 即用型代理：无需修改代码，访问 `自定义域名/你的-emby-域名:端口` 即可代理任意 Emby 服务器，开箱即用。

### ✨ 前后端分离反代 (emby-cf-proxy.js)
- 前后端分离代理：需在代码中填写前端登录域名，后端推流地址自动转发，适配前后端分离部署的 Emby 服务。

## 📌 使用方法
### ✨ 通用反代 (emby-cf-auto-proxy.js)
- https://<Worker域名>/<你的Emby服务器地址:端口>

- 示例：`https://xxx.xxx.workers.dev/emby.example.com:8096`

### ✨ 前后端分离反代 (emby-cf-proxy.js)
- 在代码内填写前端登录域名
- 直接访问 https://<Worker域名> 即可自动转发后端推流地址。

## 🌟 核心特性
- 🚀 智能缓存：图片资源边缘节点缓存，大幅提升封面/图片加载速度，降低源服务器压力
- 🛡️ 特征隐藏：清除 Cloudflare 追踪头，避免 Emby 识别节点特征并拦截
- 🎬 流媒体优化：视频流零缓存透传，WebSocket 直通无延迟，充分利用带宽跑满播放速度
- 🎨 自适应 UI：响应式代理说明页面，一键复制反代地址，适配移动端/深色模式

## 🚀 快速部署
- 打开 Cloudflare Dashboard，选择你的域名
- 进入 Workers & Pages → 创建应用程序 → 创建 Worker
- 删除编辑器里的默认代码
- 粘贴对应脚本代码
- 点击 保存并部署，记录分配的 Worker 域名


