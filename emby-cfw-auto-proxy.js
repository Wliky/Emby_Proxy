// ==================== Emby Proxy (Cloudflare Worker) ====================
// 功能说明：基于 Cloudflare Worker 实现 Emby 反代，优化流媒体转发/图片缓存/节点特征隐藏
// 使用方式：部署到 CF Worker 后，访问 https://<你的域名>/<Emby服务器地址:端口> 即可反代访问

// ==================== 【核心自定义配置区】 ====================
// 建议修改以下参数适配你的使用场景，其余代码无需改动
const CONFIG = {
  // 图片强缓存时间（单位：秒），默认 30 天 (2592000 秒)
  // 调大可减少重复请求，调小可更快更新封面；建议范围 86400(1天) ~ 2592000(30天)
  CACHE_TTL: 2592000,
  
  // Cloudflare 特征头清理列表：移除这些请求头可防止 Emby 识别 CF 节点并拦截
  // 无需新增，默认已覆盖主流追踪头；若仍被拦截可补充服务商特有头（如 x-cf-* 开头）
  STRIP_HEADERS: [
    'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry',
    'x-forwarded-for', 'x-real-ip', 'true-client-ip'
  ]
};

// ==================== 【核心逻辑区】 ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean); // 拆分路径并过滤空值

    // 1. 根路径访问：渲染自定义 UI 页面（展示反代使用说明）
    if (pathSegments.length === 0) return renderUI(request);

    // 2. 解析目标 Emby 服务器地址
    // 支持两种路径格式：
    // - 格式1：/emby.example.com:8096 (直接拼接目标地址)
    // - 格式2：/proxy-domain/emby.example.com:8096 (兼容特殊路由场景)
    let targetHost, targetPath;
    if (pathSegments[0] === 'proxy-domain') {
      if (pathSegments.length < 2) return new Response('Bad Request', { status: 400 });
      targetHost = pathSegments[1]; // 提取目标服务器域名/IP+端口
      targetPath = '/' + pathSegments.slice(2).join('/'); // 提取目标路径
    } else {
      targetHost = pathSegments[0];
      targetPath = '/' + pathSegments.slice(1).join('/');
    }

    // 拼接完整的目标请求地址
    const targetUrl = new URL(`https://${targetHost}${targetPath}${url.search}`);

    // 3. WebSocket 直通处理：适配 Emby 实时通信场景（如直播、通知）
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const wsHeaders = new Headers(request.headers);
      wsHeaders.set('Host', targetUrl.host); // 替换 Host 头为目标服务器
      wsHeaders.set('Origin', targetUrl.origin); // 适配跨域 WebSocket 连接
      return fetch(targetUrl.toString(), { headers: wsHeaders });
    }

    // 4. HTTP 请求转发：针对图片/视频流/API 做差异化优化
    return handleRequest(request, targetUrl);
  }
};

/**
 * 处理 HTTP 请求转发的核心函数
 * @param {Request} request 原始请求对象
 * @param {URL} targetUrl 解析后的目标 Emby 服务器地址
 * @returns {Response} 转发后的响应对象
 */
async function handleRequest(request, targetUrl) {
  const path = targetUrl.pathname.toLowerCase();

  // 请求类型分类：用于差异化缓存/转发策略
  const isImage = path.includes('/images/') || /\.(jpg|jpeg|png|webp|ico|gif)$/.test(path); // 图片请求
  const isStream = path.includes('/stream') || path.includes('/hls') || /\.(mp4|mkv|m3u8|ts|avi)$/.test(path); // 视频流请求

  // 整理请求头：清理/替换关键头信息
  const headers = new Headers(request.headers);
  headers.set('Host', targetUrl.host); // 替换 Host 头为目标服务器
  headers.delete('Origin'); // 移除防盗链头，避免 Emby 跨域限制
  headers.delete('Referer'); // 移除来源头，提升兼容性
  CONFIG.STRIP_HEADERS.forEach(h => headers.delete(h)); // 清理 CF 特征头

  // 构造转发请求配置
  const fetchOptions = {
    method: request.method,
    headers: headers,
    redirect: 'manual', // 手动处理重定向，避免路径错乱
    body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null, // 仅非 GET/HEAD 请求携带 body
  };

  // Cloudflare 边缘缓存策略（核心优化）
  if (isImage) {
    // 图片请求：开启全局缓存，减少重复回源
    fetchOptions.cf = { cacheEverything: true, cacheTtl: CONFIG.CACHE_TTL };
  } else {
    // 视频流/API 请求：禁用缓存，保证实时性和带宽利用率
    fetchOptions.cf = { cacheTtl: 0 };
  }

  try {
    // 转发请求到目标 Emby 服务器
    const response = await fetch(targetUrl.toString(), fetchOptions);
    const resHeaders = new Headers(response.headers);

    // 清理响应安全头：避免客户端解析/嵌入受阻
    ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security'].forEach(h => resHeaders.delete(h));

    // 响应头优化：适配 Emby 客户端行为
    if (isImage) {
      // 图片响应：强制客户端本地缓存，提升加载速度
      resHeaders.set('Cache-Control', `public, max-age=${CONFIG.CACHE_TTL}, immutable`);
    } else if (!isStream) {
      // API 响应：禁用缓存，保证播放进度/数据实时同步
      resHeaders.set('Cache-Control', 'no-store');
    }

    // 跨域配置：允许客户端获取流媒体关键头信息
    resHeaders.set('Access-Control-Allow-Origin', '*');
    resHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, X-Emby-Version');

    // 强制长连接：优化视频切片请求的连接复用，减少延迟
    resHeaders.set('Connection', 'keep-alive');

    // 处理重定向：修正回环重定向的路径，避免域名错乱
    if ([301, 302, 307, 308].includes(response.status)) {
      const loc = resHeaders.get('Location');
      if (loc && loc.includes(targetUrl.host)) {
        const locUrl = new URL(loc);
        resHeaders.set('Location', locUrl.pathname + locUrl.search); // 仅保留路径+参数，避免重定向到原域名
      }
    }

    // 返回处理后的响应
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders
    });

  } catch (err) {
    // 异常处理：返回网关错误信息
    return new Response(JSON.stringify({ error: 'Gateway Error', msg: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 渲染自定义 UI 页面：展示反代使用说明，支持一键复制反代地址
 * @param {Request} request 原始请求对象
 * @returns {Response} HTML 页面响应
 */
async function renderUI(request) {
  const userAgent = request.headers.get('user-agent') || '';
  const isMobile = /mobile|android|iphone|ipad|phone/i.test(userAgent); // 检测移动端
  const prefersDark = request.headers.get('sec-ch-prefers-color-scheme') === 'dark' || false; // 检测深色模式
  const host = request.headers.get('host') || 'proxy.example.com'; // 当前 Worker 域名

  // UI 样式配置（可自定义修改）
  const faviconUrl = 'https://avatars.githubusercontent.com/u/63444769?v=4'; // 页面图标
  const backgroundUrl = 'https://t.alcy.cc/ycy'; // 背景图
  const cardOpacity = 0.2; // 卡片透明度
  const blurIntensity = 4; // 毛玻璃模糊强度
  const cardTitle = 'Emby Proxy'; // 页面标题
  const cardSubtitle = '一键复制代理地址 轻松反代媒体服务器'; // 页面副标题
  const titleColor = prefersDark ? '#e2e8f0' : '#1e293b'; // 标题颜色
  const subtitleColor = prefersDark ? '#94a3b8' : '#64748b'; // 副标题颜色
  const highlightColor = prefersDark ? '#fbbf24' : '#f59e0b'; // 高亮色（复制代码块）

  // 响应式字体大小
  const titleSize = isMobile ? '1.8rem' : '2.2rem';
  const subtitleSize = isMobile ? '0.95rem' : '1.1rem';
  const codeSize = isMobile ? '0.9rem' : '1rem';

  // 生成 HTML 页面
  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${prefersDark ? 'dark' : 'light'}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${cardTitle}</title>
    <link rel="icon" href="${faviconUrl}">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: ${isMobile ? '20px' : '24px'};
            background: url('${backgroundUrl}') center/cover no-repeat fixed;
            color: ${prefersDark ? '#f1f5f9' : '#1e293b'};
        }
        body::before {
            content: '';
            position: fixed;
            inset: 0;
            background: ${prefersDark ? 'rgba(15,23,42,0.4)' : 'rgba(255,255,255,0.4)'};
            z-index: -1;
        }
        .container { max-width:650px; width:100%; }
        .card {
            background: rgba(${prefersDark ? '15,23,42' : '255,255,255'}, ${cardOpacity});
            border-radius: 26px;
            padding: ${isMobile ? '28px 24px' : '36px 32px'};
            box-shadow: 0 10px 30px rgba(0,0,0,${prefersDark ? '0.2' : '0.06'});
            border: 1px solid ${prefersDark ? 'rgba(51,65,85,0.3)' : 'rgba(226,232,240,0.5)'};
            backdrop-filter: blur(${blurIntensity}px);
            text-align: center;
        }
        .logo {
            width: 70px; height:70px; margin:0 auto 20px;
            border-radius: 20px; overflow:hidden;
            border: 2px solid ${prefersDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.2)'};
        }
        .logo img { width:100%; height:100%; object-fit:cover; }
        .title {
            font-size: ${titleSize}; font-weight:600; margin-bottom:8px;
            color: ${titleColor};
        }
        .subtitle {
            font-size: ${subtitleSize}; color: ${subtitleColor}; margin-bottom:24px;
        }
        .code-wrapper {
            position: relative; margin-bottom:24px;
            border-radius: 20px; overflow:hidden;
            background: rgba(${prefersDark ? '15,23,42' : '255,255,255'}, ${cardOpacity*0.8});
            border: 1px solid ${prefersDark ? 'rgba(51,65,85,0.2)' : 'rgba(226,232,240,0.3)'};
            cursor: pointer;
            backdrop-filter: blur(${blurIntensity}px);
        }
        .code-wrapper:hover {
            border-color: ${prefersDark ? 'rgba(251,191,36,0.3)' : 'rgba(245,158,11,0.3)'};
            background: rgba(${prefersDark ? '15,23,42' : '255,255,255'}, ${cardOpacity*1.2});
        }
        .copy-hint {
            position: absolute; top:0; right:0;
            background: ${highlightColor}; color:white;
            font-size:0.7rem; font-weight:600;
            padding:3px 8px; border-bottom-left-radius:8px;
            opacity:0; visibility:hidden;
            transition: all 0.2s ease;
        }
        .code-wrapper:hover .copy-hint { opacity:1; visibility:visible; }
        .code-block {
            font-size: ${codeSize};
            padding:20px 18px;
            color: ${prefersDark ? 'rgba(226,232,240,0.95)' : 'rgba(30,41,59,0.95)'};
            word-break:break-all; text-align:left; white-space:pre-wrap;
        }
        .code-part {
            color: ${highlightColor}; font-weight:600;
            background: ${prefersDark ? 'rgba(251,191,36,0.06)' : 'rgba(245,158,11,0.06)'};
            padding:2px 6px; border-radius:4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <div class="logo"><img src="${faviconUrl}" alt="Logo"></div>
            <h1 class="title">${cardTitle}</h1>
            <div class="subtitle">${cardSubtitle}</div>
            <div class="code-wrapper" id="codeWrapper">
                <div class="copy-hint" id="copyHint">点击复制</div>
                <div class="code-block">https://${host}/<span class="code-part">your-emby-server.com:8096</span></div>
            </div>
        </div>
    </div>
    <script>
        // 一键复制反代地址功能
        const codeWrapper = document.getElementById('codeWrapper');
        const copyHint = document.getElementById('copyHint');
        codeWrapper.addEventListener('click', async function() {
            const textToCopy = 'https://${host}/your-emby-server.com:8096';
            try { await navigator.clipboard.writeText(textToCopy); }
            catch { const ta = document.createElement('textarea'); ta.value = textToCopy; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
            copyHint.textContent = '✓ 已复制';
            copyHint.style.background = '#10b981';
            copyHint.style.opacity = '1';
            copyHint.style.visibility = 'visible';
            setTimeout(() => {
                copyHint.textContent = '点击复制';
                copyHint.style.background = '${highlightColor}';
                copyHint.style.opacity = '';
                copyHint.style.visibility = '';
            }, 2000);
        });
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate', // 禁用 UI 页面缓存
    },
  });
}
