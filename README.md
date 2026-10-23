# Emby Proxy (Cloudflare Worker)

基于 Cloudflare Worker 的 Emby 反代脚本集合，解决地域拦截/访问限制，并优化流媒体转发体验。

## 文件说明

- `emby-cfw-auto-proxy.js`：通用自动反代。无需改代码，访问 `https://<Worker域名>/<你的Emby服务器地址:端口>` 即可代理。
- `emby-cfw-proxy.js`：前后端分离反代。需在代码内填写前端登录域名，后端推流地址自动转发。
- `emby-cfw-fast-proxy.js`：路径路由极速版。在 `PATH_ROUTES` 配置路径到上游的映射，访问 `https://<Worker域名>/<routeKey>` 选线。

## 使用方法

### 通用自动反代

```
https://<Worker域名>/<你的Emby服务器地址:端口>
```

示例：

```
https://xxx.xxx.workers.dev/emby.example.com:8096
```

### 前后端分离反代

1. 在 `emby-cfw-proxy.js` 内填写前端登录域名（如 `FRONTEND_URL`）。
2. 直接访问 `https://<Worker域名>`，后端推流地址自动转发。

### 路径路由极速版

配置示例（仅示例，部署前替换为自己的上游）：

```js
const PATH_ROUTES = {
    demo1: ['https://emby-a.example.com'],
    demo2: ['https://emby-b.example.com/emby'],
    demo3: ['https://1.2.3.4:8096'],
};
```

访问方式：

```
https://<Worker域名>/demo1
https://<Worker域名>/demo2
https://<Worker域名>/demo3
```

健康检查：

```
https://<Worker域名>/health
```

## 核心特性

- 智能缓存：图片资源边缘节点缓存，提升封面/图片加载速度
- 特征隐藏：清除 Cloudflare 追踪头，避免被识别节点特征并拦截
- 流媒体优化：视频流零缓存透传，WebSocket 直通
- 兼容兜底：路径路由版支持 `/emby` 前缀兜底候选

## 部署

1. 打开 Cloudflare Dashboard，选择你的域名
2. 进入 Workers & Pages → 创建应用程序 → 创建 Worker
3. 删除编辑器默认代码
4. 粘贴对应脚本代码
5. 点击保存并部署，记录分配的 Worker 域名

## 验证

```bash
curl -s https://<Worker域名>/health
```

```bash
curl -I "https://<Worker域名>/demo1/Items/1/Images/Primary?tag=abc"
```

```bash
curl -I -H "Range: bytes=0-1023" "https://<Worker域名>/demo1/videos/1/stream.mp4?static=true"
```
