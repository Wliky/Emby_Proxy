# Emby Proxy (Cloudflare Worker)

本仓库包含三类脚本：

- `emby-cfw-auto-proxy.js`：通用自动代理（原有文件，保留）
- `emby-cfw-proxy.js`：前后端分离代理（原有文件，保留）
- `release-fast-1.6.0/worker.js`：路径路由版 Emby 代理（本次新增）

## 1. 本次更新说明

- 新增目录：`release-fast-1.6.0/`
- 新增文件：`release-fast-1.6.0/worker.js`
- `PATH_ROUTES` 已改为示例值，不包含任何真实上游地址
- 原有脚本与目录保持不变

## 2. 路径路由版（release-fast-1.6.0）

该版本按 `https://你的域名/{routeKey}` 选线到不同上游，适合多线路 Emby 反代。

### 2.1 `PATH_ROUTES` 示例（仅示例）

```js
const PATH_ROUTES = {
    demo1: ['https://emby-a.example.com'],
    demo2: ['https://emby-b.example.com/emby'],
    demo3: ['https://1.2.3.4:8096'],
};
```

请在部署前替换成你自己的上游地址。

### 2.2 访问方式

- `https://你的域名/demo1`
- `https://你的域名/demo2`
- `https://你的域名/demo3`

根路径和健康检查：

- `https://你的域名/`
- `https://你的域名/health`

### 2.3 核心行为

- 流媒体请求：不缓存、尽量零干预透传（保留 Range）
- 图片请求：边缘缓存 + 浏览器缓存
- 列表请求（`/Items`）：短缓存
- `PlaybackInfo`：可选改写为代理路径
- 上游候选：主候选 + `/emby` 前缀兜底（兼容客户端有无 `/emby`）

## 3. Cloudflare Worker 部署

1. 新建 Worker。
2. 粘贴目标脚本内容：
   - 路径路由版：`release-fast-1.6.0/worker.js`
   - 或保留使用原有两个脚本之一。
3. 修改 `PATH_ROUTES` 为你的实际配置。
4. 绑定自定义域名并发布。

## 4. 快速验证

```bash
curl -s https://你的域名/health
```

```bash
curl -I "https://你的域名/demo1/Items/1/Images/Primary?tag=abc"
```

```bash
curl -I -H "Range: bytes=0-1023" "https://你的域名/demo1/videos/1/stream.mp4?static=true"
```
