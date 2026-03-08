// ==================== Emby 专属客户端极速版核心配置 ====================
const CONFIG = {
  // 图片资源强缓存时间（单位：秒），设置为30天（2592000秒）
  // 目的：减少重复请求，提升客户端图片加载速度
  CACHE_TTL: 2592000,
  // 需要清除的 Cloudflare 特征头列表
  // 作用：防止 Emby 服务器通过这些头信息识别节点特征并拦截请求
  STRIP_HEADERS: [
    'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry',
    'x-forwarded-for', 'x-real-ip', 'true-client-ip'
  ]
};

// 默认前端服务地址（兜底转发）
// 当请求路径不匹配代理规则时，所有请求转发到此地址
const FRONTEND_URL = "http://line.xmsl.org:80";

/**
 * 核心请求处理函数
 * @param {Request} request - Cloudflare 接收到的原始请求对象
 * @returns {Response} - 处理后的响应对象
 */
async function handleRequest(request) {
  const url = new URL(request.url);

  // 1. 处理 OPTIONS 预检请求（解决跨域问题）
  // 第三方 Emby 客户端会先发 OPTIONS 请求验证 CORS 策略，必须正确响应
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",          // 允许所有源跨域
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", // 允许所有常用方法
        "Access-Control-Allow-Headers": "*",         // 允许所有请求头
        "Access-Control-Max-Age": "86400",           // 预检结果缓存24小时
      },
    });
  }

  // 2. 解析目标请求地址（核心路由逻辑）
  const decodedPath = decodeURIComponent(url.pathname);
  let targetUrlStr;

  if (decodedPath.startsWith('/http://') || decodedPath.startsWith('/https://')) {
    // 处理后端重定向包装的绝对URL
    // 后端返回的30x重定向会被包装成 /http://xxx 形式，此处解包还原真实地址
    targetUrlStr = decodedPath.substring(1) + url.search;
  } else if (decodedPath.startsWith('/proxy-domain/')) {
    // 处理动态代理路径：/proxy-domain/[主机名]/[路径]
    // 示例：/proxy-domain/emby.example.com:8096/emby/Items/123
    const segments = decodedPath.split('/').filter(Boolean); // 分割路径并过滤空值
    if (segments.length < 2) {
      return new Response('Bad Request: missing host in /proxy-domain/', { status: 400 });
    }
    const host = segments[1];                // 提取目标主机（可带端口）
    const restPath = '/' + segments.slice(2).join('/'); // 提取剩余路径
    targetUrlStr = `https://${host}${restPath}${url.search}`;
  } else {
    // 兜底规则：所有未匹配的请求转发到前端地址
    targetUrlStr = FRONTEND_URL + url.pathname + url.search;
  }

  // 构造目标URL对象，便于后续操作
  const targetUrl = new URL(targetUrlStr);

  // 3. WebSocket 直通处理（实时通信优化）
  // Emby 客户端的实时交互依赖WebSocket，此处直接转发不做额外处理
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    const wsHeaders = new Headers(request.headers);
    wsHeaders.set('Host', targetUrl.host);    // 设置正确的目标主机头
    wsHeaders.set('Origin', targetUrl.origin); // 设置正确的源地址
    return fetch(targetUrl.toString(), { headers: wsHeaders });
  }

  // 4. 清理并重构请求头（核心防拦截逻辑）
  const newHeaders = new Headers(request.headers);
  newHeaders.set("Host", targetUrl.host);    // 必须设置目标主机，否则后端拒绝
  // 移除所有CF特征头，防止Emby识别节点
  CONFIG.STRIP_HEADERS.forEach(header => newHeaders.delete(header));
  // 移除防盗链相关头，避免部分Emby服务的严格限制
  newHeaders.delete('Origin');
  newHeaders.delete('Referer');

  // 5. 识别请求类型，应用差异化缓存策略
  const path = targetUrl.pathname.toLowerCase();
  // 判断是否为图片请求（需要强缓存）
  const isImage = path.includes('/images/') || /\.(jpg|jpeg|png|webp|ico|gif)$/.test(path);
  // 判断是否为视频流请求（禁止缓存）
  const isStream = path.includes('/stream') || path.includes('/hls') || /\.(mp4|mkv|m3u8|ts|avi)$/.test(path);

  // 6. 构造转发请求参数
  const fetchOptions = {
    method: request.method,                  // 保持原始请求方法
    headers: newHeaders,                     // 使用清理后的请求头
    // 非GET/HEAD请求保留请求体，使用流式处理避免内存溢出
    body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
    redirect: 'manual'                       // 手动处理重定向，便于包装地址
  };

  // 7. 设置Cloudflare边缘缓存策略
  if (isImage) {
    // 图片请求：边缘节点缓存所有内容，缓存时间30天
    fetchOptions.cf = { cacheEverything: true, cacheTtl: CONFIG.CACHE_TTL };
  } else {
    // 非图片请求：禁止边缘缓存，保证数据实时性
    fetchOptions.cf = { cacheTtl: 0 };
  }

  try {
    // 8. 发起转发请求
    const response = await fetch(targetUrl.toString(), fetchOptions);
    const resHeaders = new Headers(response.headers);

    // 9. 包装后端重定向地址（核心代理链路保持逻辑）
    // 当后端返回30x重定向时，将绝对URL包装成Worker路径，确保后续请求仍走代理
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = resHeaders.get('Location');
      if (location && (location.startsWith('http://') || location.startsWith('https://'))) {
        resHeaders.set('Location', `/${encodeURIComponent(location)}`);
      }
    }

    // 10. 清理响应安全头（客户端兼容优化）
    // 移除可能导致客户端解析失败的安全头
    ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security'].forEach(
      header => resHeaders.delete(header)
    );

    // 11. 优化响应缓存头（客户端体验优化）
    if (isImage) {
      // 图片响应：通知客户端本地缓存30天
      resHeaders.set('Cache-Control', `public, max-age=${CONFIG.CACHE_TTL}, immutable`);
    } else if (!isStream) {
      // API请求：禁止客户端缓存，保证数据实时性
      resHeaders.set('Cache-Control', 'no-store');
    }
    // 视频流：保留后端原始缓存策略

    // 12. 跨域响应配置
    resHeaders.set('Access-Control-Allow-Origin', '*');
    // 暴露Emby客户端需要的响应头
    resHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, X-Emby-Version');

    // 13. 强制长连接（视频加载优化）
    // 视频切片请求需要长连接，减少TCP握手开销
    resHeaders.set('Connection', 'keep-alive');

    // 14. 返回最终处理后的响应
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders
    });

  } catch (err) {
    // 异常处理：返回标准化JSON错误信息
    return new Response(JSON.stringify({ 
      error: 'Gateway Error', 
      msg: err.message 
    }), {
      status: 502,          // 网关错误状态码
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' // 跨域错误响应
      }
    });
  }
}

// 注册Cloudflare Fetch事件监听
// 所有请求都交由handleRequest函数处理
addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});
