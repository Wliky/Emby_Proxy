const VERSION = 'fast-1.6.0';

// ============================== 配置区 ==============================
// 路径选线：直接用 https://你的域名/{key} 访问对应上游
const PATH_ROUTES = {
    demo1: ['https://emby-a.example.com'],
    demo2: ['https://emby-b.example.com/emby'],
    demo3: ['https://1.2.3.4:8096'],
};

// 图片边缘缓存 30 天；浏览器缓存 7 天（Emby 图片 URL 带 tag=，封面换了 URL 就变，不会读到旧图）
const IMAGE_EDGE_TTL = 2592000;
const IMAGE_BROWSER_TTL = 604800;

// 列表接口（只匹配 /Items 与 /Users/{id}/Items）边缘缓存秒数 / 浏览器缓存秒数
const LIST_EDGE_TTL = 20;
const LIST_BROWSER_TTL = 10;
const LIST_PATH_RE = /^\/(?:Users\/[^/]+\/)?Items$/i;

// PlaybackInfo 里的绝对直链改写成走本代理。关掉则完全不动响应体（理论最快）
const REWRITE_PLAYBACK_INFO = true;
// ====================================================================

const PATH_ROUTE_MAP = new Map(
    Object.entries(PATH_ROUTES).map(([key, upstreams]) => [`/${String(key).replace(/^\/+|\/+$/g, '')}`, upstreams])
);
const ALL_UPSTREAMS = [...new Set(Object.values(PATH_ROUTES).flat())];
const UPSTREAM_BASE = new Map(
    ALL_UPSTREAMS.map((u) => {
        const x = new URL(u);
        return [x.host, x.pathname.replace(/\/+$/, '')];
    })
);
const UPSTREAM_HOSTS = new Set(UPSTREAM_BASE.keys());

// 这些路径说明客户端在调 Emby API（用于补 /emby 前缀的兜底候选）
const API_PATH_RE =
    /^\/(?:Items|Videos|Audio|Users|Sessions|System|Library|LiveTv|Shows|Movies|Artists|Albums|Playlists|Channels|Devices|Packages|Plugins|ScheduledTasks|Activity|Notifications|Localization|DisplayPreferences|Environment|Branding|Images|Icons|web|emby|Favorites|Trailers|Collections|Genres|Persons|Studios|Years|Backup|Sync|Connect|UserViews|UserItems|QuickConnect)(?:\/|$)/i;

const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp)$/i;
const IMAGE_PATH_RE = /\/(?:Images|Branding|Icons)\//i;
const STREAM_EXT_RE = /\.(?:mp4|mkv|webm|mov|avi|ts|m4s|flv|mp3|m4a|aac|flac|ogg|opus|wav)$/i;
const HLS_RE = /\.m3u8$/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const PLAYBACK_KEYS = ['TranscodingUrl', 'DirectStreamUrl', 'transcodingUrl', 'directStreamUrl'];

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') return preflight();

        const relPath = url.pathname;

        // 未带路由路径时只返回健康状态（避免误走默认上游）
        if ((relPath === '/' || relPath === '/health') && !url.search) return healthResponse();

        const routed = resolveRoute(relPath);
        if (!routed) return new Response('Not Found', { status: 404 });
        const rel = routed.rel;

        const image = isImageRequest(rel, request.method);
        const stream = !image && isStreamRequest(request, rel);
        // 只有 GET 的 /Items 列表才走短缓存，详情/PlaybackInfo/图片都不在此列
        const list = !image && !stream && request.method === 'GET' && LIST_PATH_RE.test(rel);

        const targets = buildTargets(rel, url.search, routed.upstreams);

        const res = await upstreamFetch(request, targets, { image, list, stream, url, rel });

        if (!res) return new Response('Bad Gateway', { status: 502, headers: { 'access-control-allow-origin': '*' } });
        if (res.webSocket) return res; // WebSocket 直通（Emby 的 /socket）

        return image ? finalizeImage(res) : finalizePassthrough(res, request, url, rel, list, routed.routePrefix);
    },
};

// ============================== 路由 / 判定 ==============================

function isImageRequest(rel, method) {
    if (method !== 'GET' && method !== 'HEAD') return false;
    return IMAGE_EXT_RE.test(rel) || IMAGE_PATH_RE.test(rel);
}

// 命中即按“流”处理：不缓冲、不改写、不缓存
function isStreamRequest(request, rel) {
    if (request.headers.has('range')) return true;
    if (STREAM_EXT_RE.test(rel) || HLS_RE.test(rel)) return true;
    if (/\/stream(?:\.|\/|$)/i.test(rel)) return true;
    if (/\/streams?\//i.test(rel)) return true;
    if (/\/(?:videos|audio)\/[^/]+\/(?:original|master|main|hls)/i.test(rel)) return true;
    return false;
}

function joinPath(basePath, rel) {
    if (!basePath) return rel;
    if (rel === basePath || rel.startsWith(basePath + '/')) return rel;
    return basePath + rel;
}

function resolveRoute(rel) {
    const m = rel.match(/^\/([^/]+)/);
    if (!m) return null;

    const routePrefix = `/${m[1]}`;
    const upstreams = PATH_ROUTE_MAP.get(routePrefix);
    if (!upstreams) return null;

    const nextRel = rel.length === routePrefix.length ? '/' : rel.slice(routePrefix.length);
    return { rel: nextRel || '/', upstreams, routePrefix };
}

// 生成上游候选：主候选 + /emby 前缀兜底（Emby 客户端有时自带、有时不带）
function buildTargets(rel, search, upstreams) {
    const out = [];
    for (const base of upstreams) {
        const u = new URL(base);
        const bp = u.pathname.replace(/\/+$/, '');
        const add = (p) => {
            const full = u.origin + joinPath(bp, p) + search;
            if (!out.includes(full)) out.push(full);
        };
        add(rel);
        if (!bp) {
            if (/^\/emby(?=\/|$)/i.test(rel)) add(rel.replace(/^\/emby/i, '') || '/');
            else if (API_PATH_RE.test(rel)) add('/emby' + rel);
        }
    }
    return out;
}

// ============================== 上游请求 ==============================

async function upstreamFetch(request, targets, ctx) {
    if (!targets.length) return null;
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request);

    for (const target of targets) {
        try {
            const init = {
                method: request.method,
                headers: buildHeaders(request, target, ctx),
                redirect: 'follow',
                body,
            };

            if (ctx.image) {
                init.cf = cacheCfOptions(IMAGE_EDGE_TTL);
                init.signal = AbortSignal.timeout(8000);
            } else if (ctx.list) {
                init.cf = cacheCfOptions(LIST_EDGE_TTL);
                init.signal = AbortSignal.timeout(8000);
            } else {
                init.cf = { cacheEverything: false };
                if (!ctx.stream) init.signal = AbortSignal.timeout(15000);
            }

            const res = await fetch(target, init);
            if (res.status >= 500) {
                try {
                    await res.body?.cancel();
                } catch {}
                continue;
            }
            return res;
        } catch {
            continue;
        }
    }

    return null;
}

async function readBody(request) {
    const len = Number(request.headers.get('content-length') || '0');
    // 大文件（字幕/图片上传）直接流式转发，不占内存、不重试
    if (len > 8 * 1024 * 1024) return request.body;
    return await request.arrayBuffer();
}

function buildHeaders(request, target, ctx) {
    const src = request.headers;
    const targetUrl = new URL(target);
    const h = new Headers(src);
    const ip = src.get('cf-connecting-ip');

    h.delete('host');
    h.delete('cf-connecting-ip');
    h.delete('cf-ipcountry');
    h.delete('cf-ray');
    h.delete('cf-visitor');
    h.delete('cf-worker');
    h.delete('cdn-loop');
    h.delete('x-forwarded-for');
    h.delete('x-real-ip');

    if (ip) {
        h.set('x-forwarded-for', ip);
        h.set('x-real-ip', ip);
    }
    h.set('x-forwarded-proto', ctx.url.protocol.replace(':', ''));
    h.set('x-forwarded-host', ctx.url.host);

    const origin = h.get('origin');
    if (origin) h.set('origin', targetUrl.origin);
    const referer = h.get('referer');
    if (referer && referer.startsWith(ctx.url.origin)) {
        h.set('referer', referer.replace(ctx.url.origin, targetUrl.origin));
    }

    return h;
}

function cacheCfOptions(ttl) {
    return {
        cacheEverything: true,
        // 覆盖上游的 Cache-Control（Emby 的 API 常带 no-cache），按状态码给 TTL
        cacheTtlByStatus: { '200-299': ttl, '301-302': 3600, '404': 60, '500-599': 0 },
    };
}

// ============================== 响应处理 ==============================

function finalizeImage(res) {
    const headers = new Headers(res.headers);
    headers.delete('set-cookie');
    headers.delete('vary');
    headers.delete('expires');
    headers.set('cache-control', `public, max-age=${IMAGE_BROWSER_TTL}, immutable`);
    headers.set('access-control-allow-origin', '*');
    headers.set('cross-origin-resource-policy', 'cross-origin');

    if (res.status === 204 || res.status === 304) return new Response(null, { status: res.status, headers });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function finalizePassthrough(res, request, url, rel, list, routePrefix) {
    const headers = new Headers(res.headers);
    fixSetCookie(headers);
    headers.set('access-control-allow-origin', '*');

    if (list) {
        // 边缘已经缓存了，浏览器也让它短暂复用，避免每次切页都发一次请求
        headers.delete('set-cookie');
        headers.delete('vary');
        if (res.status === 200) headers.set('cache-control', `public, max-age=${LIST_BROWSER_TTL}`);
    }

    if (REDIRECT_STATUS.has(res.status)) {
        const loc = headers.get('location');
        const mapped = loc ? toProxyPath(loc, url, routePrefix) : null;
        if (mapped) headers.set('location', mapped);
    }

    // 只对 PlaybackInfo 做响应体改写：体积小，且直接决定启播链路能不能走代理
    if (REWRITE_PLAYBACK_INFO && res.status === 200 && /\/PlaybackInfo$/i.test(rel)) {
        const ct = headers.get('content-type') || '';
        if (ct.includes('json')) {
            try {
                const text = await res.text();
                let out = text;
                try {
                    const json = JSON.parse(text);
                    if (rewritePlaybackUrls(json, url, routePrefix)) out = JSON.stringify(json);
                } catch {}
                headers.delete('content-encoding');
                headers.delete('content-length');
                headers.delete('etag');
                return new Response(out, { status: res.status, headers });
            } catch {}
        }
    }

    if (res.status === 204 || res.status === 304) return new Response(null, { status: res.status, headers });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// 上游返回的绝对地址 → 走本代理的相对路径（主机不在上游列表里的 CDN 地址保持原样，让客户端直连）
function toProxyPath(absUrl, requestUrl, routePrefix = '') {
    try {
        const u = new URL(absUrl, requestUrl.origin);
        if (!UPSTREAM_HOSTS.has(u.host)) return null;
        const bp = UPSTREAM_BASE.get(u.host) || '';
        let path = u.pathname;
        if (bp && path.startsWith(bp)) path = path.slice(bp.length) || '/';
        const base = routePrefix.replace(/\/+$/, '');
        return (base || '') + path + u.search;
    } catch {
        return null;
    }
}

function rewritePlaybackUrls(json, requestUrl, routePrefix) {
    const sources = json && (json.MediaSources || json.mediaSources);
    if (!Array.isArray(sources)) return false;

    let changed = false;
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const key of PLAYBACK_KEYS) {
            const value = source[key];
            if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;
            const mapped = toProxyPath(value, requestUrl, routePrefix);
            if (mapped && mapped !== value) {
                source[key] = mapped;
                changed = true;
            }
        }
    }
    return changed;
}

// Emby 的 Set-Cookie 带 Domain，落到反代域名上会被浏览器丢弃；去掉 Domain 让它生效
function fixSetCookie(headers) {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : null;
    const cookies = list && list.length ? list : (headers.get('set-cookie') || '').split(/,(?=\s*[^;,]+=)/g).filter(Boolean);
    if (!cookies.length) return;

    headers.delete('set-cookie');
    for (const cookie of cookies) headers.append('set-cookie', cookie.replace(/;\s*domain=[^;]*/gi, ''));
}

function healthResponse() {
    return new Response(
        JSON.stringify({
            ok: true,
            version: VERSION,
            mode: 'health-only-without-route',
            routes: [...PATH_ROUTE_MAP.keys()],
        }),
        {
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            },
        }
    );
}

function preflight() {
    return new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
            'access-control-allow-headers': '*',
            'access-control-expose-headers': '*',
            'access-control-max-age': '86400',
        },
    });
}
