// ==================== Emby Proxy (Cloudflare Worker) ====================
// 路径路由极速版（自用）：按 https://<Worker域名>/<routeKey> 选线到不同上游
// ======================================================================
const VERSION = 'fast-self-3.0.0';

// ============================== 配置区 ==============================
// 路径选线：直接用 https://你的域名/{key} 访问对应上游
const PATH_ROUTES = {
    demo1: ['https://emby-a.example.com'],
    demo2: ['https://emby-b.example.com/emby'],
    demo3: ['https://1.2.3.4:8096'],
};

// 图片边缘缓存 30 天；浏览器缓存 7 天
const IMAGE_EDGE_TTL = 2592000;
const IMAGE_BROWSER_TTL = 604800;

// 列表接口（只匹配 /Items 与 /Users/{id}/Items）边缘缓存秒数 / 浏览器缓存秒数
const LIST_EDGE_TTL = 20;
const LIST_BROWSER_TTL = 10;
const LIST_PATH_RE = /^\/(?:Users\/[^/]+\/)?Items$/i;

// 多候选时首路探测超时（毫秒）：慢就尽快切下一个候选
const FIRST_PROBE_TIMEOUT_MS = 3800;
// 流媒体首包握手超时（毫秒）：仅用于多候选快速切线
const STREAM_CONNECT_TIMEOUT_MS = 4500;
// 非流请求常规超时（毫秒）
const NON_STREAM_TIMEOUT_MS = 12000;
// 图片/列表请求超时（毫秒）
const CACHEABLE_TIMEOUT_MS = 7000;
// 上游失败短时惩罚窗口（毫秒）
const UPSTREAM_FAIL_PENALTY_MS = 15000;
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// ====================================================================

// 预解析路由上游，避免每请求重复 URL 解析
const PATH_ROUTE_MAP = new Map();
const ALL_UPSTREAMS = [];
for (const [key, upstreams] of Object.entries(PATH_ROUTES)) {
    const routePrefix = `/${String(key).replace(/^\/+|\/+$/g, '')}`;
    const parsed = [];
    for (let i = 0; i < upstreams.length; i++) {
        const u = new URL(upstreams[i]);
        const basePath = u.pathname.replace(/\/+$/, '');
        const item = { origin: u.origin, host: u.host, basePath, upstreamIndex: i };
        parsed.push(item);
        ALL_UPSTREAMS.push(item);
    }
    PATH_ROUTE_MAP.set(routePrefix, parsed);
}

const UPSTREAM_BASE = new Map();
for (const u of ALL_UPSTREAMS) {
    if (!UPSTREAM_BASE.has(u.host)) UPSTREAM_BASE.set(u.host, u.basePath);
}
const UPSTREAM_HOSTS = new Set(ALL_UPSTREAMS.map((u) => u.host));

// 这些路径说明客户端在调 Emby API（用于补 /emby 前缀的兜底候选）
const API_PATH_RE =
    /^\/(?:Items|Videos|Audio|Users|Sessions|System|Library|LiveTv|Shows|Movies|Artists|Albums|Playlists|Channels|Devices|Packages|Plugins|ScheduledTasks|Activity|Notifications|Localization|DisplayPreferences|Environment|Branding|Images|Icons|web|emby|Favorites|Trailers|Collections|Genres|Persons|Studios|Years|Backup|Sync|Connect|UserViews|UserItems|QuickConnect)(?:\/|$)/i;

const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp)$/i;
const IMAGE_PATH_RE = /\/(?:Images|Branding|Icons)\//i;
const STREAM_EXT_RE = /\.(?:mp4|mkv|webm|mov|avi|ts|m4s|flv|mp3|m4a|aac|flac|ogg|opus|wav)$/i;
const HLS_RE = /\.m3u8$/i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const AUTH_QUERY_KEY_SET = new Set(['api_key', 'x-emby-token', 'x-mediabrowser-token', 'x-mediabrowsertoken']);

// 热实例内轻量状态：快速命中最近成功线路，短暂避开失败线路
const ROUTE_LAST_GOOD_INDEX = new Map();
const UPSTREAM_FAIL_UNTIL = new Map();

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
        // 仅 GET 的 /Items 列表走短缓存
        const list = !image && !stream && request.method === 'GET' && LIST_PATH_RE.test(rel);

        const targets = buildTargets(rel, url.search, routed.upstreams);
        const authFingerprint = extractAuthFingerprint(request, url);
        const res = await upstreamFetch(request, targets, {
            image,
            list,
            stream,
            url,
            routePrefix: routed.routePrefix,
            authFingerprint,
        });

        if (!res) return new Response('Bad Gateway', { status: 502, headers: { 'access-control-allow-origin': '*' } });
        if (res.webSocket) return res; // WebSocket 直通

        return image ? finalizeImage(res) : finalizePassthrough(res, url, list, routed.routePrefix, stream);
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

// 生成上游候选：主候选 + /emby 前缀兜底（兼容客户端有无 /emby）
function buildTargets(rel, search, upstreams) {
    const out = [];
    const seen = new Set();

    for (const u of upstreams) {
        const add = (p, prefer = 0) => {
            const full = u.origin + joinPath(u.basePath, p) + search;
            if (seen.has(full)) return;
            seen.add(full);
            out.push({
                url: full,
                host: u.host,
                origin: u.origin,
                upstreamIndex: u.upstreamIndex,
                prefer,
            });
        };

        add(rel, 0);
        if (!u.basePath) {
            if (/^\/emby(?=\/|$)/i.test(rel)) add(rel.replace(/^\/emby/i, '') || '/', 1);
            else if (API_PATH_RE.test(rel)) add('/emby' + rel, 1);
        }
    }

    return out;
}

// ============================== 上游请求 ==============================

async function upstreamFetch(request, targets, ctx) {
    if (!targets.length) return null;

    const payload = await readBody(request);
    const ordered = prioritizeTargets(targets, ctx.routePrefix);
    const attempts = payload.retryable ? ordered.length : 1;
    const baseHeaders = buildBaseHeaders(request, ctx);

    for (let i = 0; i < attempts; i++) {
        const candidate = ordered[i];
        try {
            const init = {
                method: request.method,
                headers: buildHeaders(baseHeaders, candidate.origin, ctx.url.origin),
                redirect: 'follow',
                body: payload.body,
            };

            if (ctx.image) {
                init.cf = {
                    ...cacheCfOptions(IMAGE_EDGE_TTL),
                    cacheKey: buildCacheKey(candidate.url, ctx.authFingerprint, true),
                };
            } else if (ctx.list) {
                init.cf = {
                    ...cacheCfOptions(LIST_EDGE_TTL),
                    cacheKey: buildCacheKey(candidate.url, ctx.authFingerprint, false),
                };
            } else {
                init.cf = { cacheEverything: false };
            }

            const timeoutMs = getTimeoutMs(ctx, i, attempts);
            const res = await fetchWithTimeout(candidate.url, init, timeoutMs);

            if (shouldTryAltPath(res.status, ordered, i, candidate)) {
                try {
                    await res.body?.cancel();
                } catch {}
                continue;
            }

            if (shouldRetryStatus(res.status)) {
                markUpstreamFail(candidate.host);
                if (i + 1 < attempts) {
                    try {
                        await res.body?.cancel();
                    } catch {}
                    continue;
                }
                return res;
            }

            markUpstreamOk(candidate.host);
            if (ctx.routePrefix) ROUTE_LAST_GOOD_INDEX.set(ctx.routePrefix, candidate.upstreamIndex);
            return res;
        } catch {
            markUpstreamFail(candidate.host);
        }
    }

    return null;
}

function getTimeoutMs(ctx, attemptIndex, attempts) {
    if (ctx.stream) return attempts > 1 ? STREAM_CONNECT_TIMEOUT_MS : 0;
    if (ctx.image || ctx.list) return CACHEABLE_TIMEOUT_MS;
    if (attemptIndex === 0 && attempts > 1) return Math.min(NON_STREAM_TIMEOUT_MS, FIRST_PROBE_TIMEOUT_MS);
    return NON_STREAM_TIMEOUT_MS;
}

function shouldRetryStatus(status) {
    return status === 429 || status >= 500;
}

function shouldTryAltPath(status, targets, index, current) {
    if (status !== 404) return false;
    for (let i = index + 1; i < targets.length; i++) {
        const next = targets[i];
        if (next.host === current.host && next.upstreamIndex === current.upstreamIndex) return true;
    }
    return false;
}

async function fetchWithTimeout(url, init, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) return fetch(url, init);

    const controller = new AbortController();
    const signal = init.signal;
    const onAbort = () => controller.abort(signal.reason);

    if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs);

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

function prioritizeTargets(targets, routePrefix) {
    if (targets.length <= 1) return targets;

    const hint = routePrefix ? ROUTE_LAST_GOOD_INDEX.get(routePrefix) : undefined;
    const now = Date.now();

    const list = targets.map((t) => {
        const score = (hint === t.upstreamIndex ? -100 : 0) + ((UPSTREAM_FAIL_UNTIL.get(t.host) || 0) > now ? 50 : 0);
        return { t, score };
    });

    list.sort((a, b) => a.score - b.score || a.t.upstreamIndex - b.t.upstreamIndex || (a.t.prefer || 0) - (b.t.prefer || 0));
    return list.map((x) => x.t);
}

function markUpstreamFail(host) {
    if (!host) return;
    UPSTREAM_FAIL_UNTIL.set(host, Date.now() + UPSTREAM_FAIL_PENALTY_MS);
}

function markUpstreamOk(host) {
    if (!host) return;
    UPSTREAM_FAIL_UNTIL.delete(host);
}

async function readBody(request) {
    if (RETRYABLE_METHODS.has(request.method)) return { body: undefined, retryable: true };
    return { body: request.body, retryable: false };
}

function extractAuthFingerprint(request, url) {
    let authToken = '';
    for (const key of AUTH_QUERY_KEY_SET) {
        const val = url.searchParams.get(key);
        if (val) {
            authToken = val;
            break;
        }
    }

    if (!authToken) {
        authToken =
            request.headers.get('x-emby-token') ||
            request.headers.get('x-mediabrowser-token') ||
            request.headers.get('x-mediabrowsertoken') ||
            extractTokenFromAuthorization(request.headers.get('authorization')) ||
            extractTokenFromCookie(request.headers.get('cookie')) ||
            '';
    }

    return hashString(authToken || 'anon');
}

function extractTokenFromAuthorization(value) {
    if (!value) return '';

    const bearer = value.match(/^\s*bearer\s+(.+)$/i);
    if (bearer) return bearer[1].trim();

    const token = value.match(/(?:^|[,\s])token="?([^",\s;]+)"?/i);
    if (token) return token[1].trim();

    return value.trim();
}

function extractTokenFromCookie(value) {
    if (!value) return '';
    const token = value.match(/(?:^|;\s*)(?:X-Emby-Token|x-emby-token|EmbyToken|embyToken)=([^;]+)/i);
    if (token) return token[1].trim();
    return value.trim();
}

function hashString(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

function buildCacheKey(targetUrl, authFingerprint, stripAuthQuery) {
    const u = new URL(targetUrl);
    const params = [];

    for (const [k, v] of u.searchParams.entries()) {
        if (stripAuthQuery && AUTH_QUERY_KEY_SET.has(k.toLowerCase())) continue;
        params.push([k, v]);
    }

    params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

    u.search = '';
    for (const [k, v] of params) u.searchParams.append(k, v);
    u.searchParams.set('__cf_auth', authFingerprint);
    return u.toString();
}

function buildBaseHeaders(request, ctx) {
    const src = request.headers;
    const h = new Headers(src);
    const ip = src.get('cf-connecting-ip');

    for (const name of [
        'host',
        'cf-connecting-ip',
        'cf-ipcountry',
        'cf-ray',
        'cf-visitor',
        'cf-worker',
        'cdn-loop',
        'x-forwarded-for',
        'x-real-ip',
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
    ]) {
        h.delete(name);
    }

    if (ip) {
        h.set('x-forwarded-for', ip);
        h.set('x-real-ip', ip);
    }

    h.set('x-forwarded-proto', ctx.url.protocol.replace(':', ''));
    h.set('x-forwarded-host', ctx.url.host);
    return h;
}

function buildHeaders(baseHeaders, targetOrigin, reqOrigin) {
    const h = new Headers(baseHeaders);

    const origin = h.get('origin');
    if (origin && targetOrigin) h.set('origin', targetOrigin);

    const referer = h.get('referer');
    if (referer && targetOrigin && referer.startsWith(reqOrigin)) {
        h.set('referer', referer.replace(reqOrigin, targetOrigin));
    }

    return h;
}

function cacheCfOptions(ttl) {
    return {
        cacheEverything: true,
        cacheTtlByStatus: { '200-299': ttl, '301-302': 3600, '404': 60, '500-599': 0 },
    };
}

// ============================== 响应处理 ==============================

function finalizeImage(res) {
    const headers = new Headers(res.headers);
    headers.delete('set-cookie');
    headers.delete('vary');
    headers.delete('expires');
    headers.set('cache-control', `public, max-age=${IMAGE_BROWSER_TTL}, stale-while-revalidate=86400, immutable`);
    headers.set('access-control-allow-origin', '*');
    headers.set('cross-origin-resource-policy', 'cross-origin');

    return buildResponse(res, headers);
}

function finalizePassthrough(res, url, list, routePrefix, stream) {
    const headers = new Headers(res.headers);
    headers.set('access-control-allow-origin', '*');

    // 流媒体走最小处理路径，减少额外头处理开销
    if (stream) return buildResponse(res, headers);

    fixSetCookie(headers);

    if (list) {
        headers.delete('set-cookie');
        headers.delete('vary');
        if (res.status === 200) {
            headers.set('cache-control', `private, max-age=${LIST_BROWSER_TTL}, stale-while-revalidate=${LIST_EDGE_TTL}`);
        }
    }

    if (REDIRECT_STATUS.has(res.status)) {
        const loc = headers.get('location');
        const mapped = loc ? toProxyPath(loc, url, routePrefix) : null;
        if (mapped) headers.set('location', mapped);
    }

    return buildResponse(res, headers);
}

function buildResponse(res, headers) {
    if (res.status === 204 || res.status === 304) return new Response(null, { status: res.status, headers });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// 上游绝对地址 -> 本代理相对地址（用于重定向回写）
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
