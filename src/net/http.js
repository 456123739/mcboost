/**
 * HTTP 基础封装：重定向跟随、超时、重试、Range 请求。
 * 仅使用 Node 内置 fetch（undici），零外部依赖。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
  'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR',
]);

export function isRetryable(err) {
  if (err instanceof HttpError) return err.status === undefined || RETRYABLE_STATUS.has(err.status);
  const code = err?.cause?.code || err?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/**
 * 带重试的 fetch。返回 Response（redirect 已跟随）。
 * @param {string} url
 * @param {object} opts
 */
export async function request(url, opts = {}) {
  const {
    headers = {},
    method = 'GET',
    timeout = 30_000,
    retries = 3,
    retryBaseDelay = 700,
    signal,
    redirect = 'follow',
    body,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('已取消');
    const composite = composeSignals(signal, AbortSignal.timeout(timeout));
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': DEFAULT_UA, 'Accept-Encoding': 'identity', ...headers },
        redirect,
        body,
        signal: composite.signal,
      });
      if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        // 消费掉 body 以释放连接
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        lastErr = new HttpError(`HTTP ${res.status}`, { status: res.status, url });
        await backoff(attempt, retryBaseDelay, res.headers.get('retry-after'), signal);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryable(err)) {
        await backoff(attempt, retryBaseDelay, null, signal);
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`请求失败: ${url}`);
}

/** 带重试的 GET JSON */
export async function getJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) throw new HttpError(`HTTP ${res.status} (${url})`, { status: res.status, url });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`响应不是合法 JSON: ${url} -> ${text.slice(0, 160)}`, { status: res.status, url });
  }
}

/** 带重试的 GET 文本 */
export async function getText(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw new HttpError(`HTTP ${res.status} (${url})`, { status: res.status, url });
  return res.text();
}

/** 探测远程文件元信息 */
export async function probeRemote(url, opts = {}) {
  const headers = { Range: 'bytes=0-0', ...(opts.headers || {}) };
  const res = await request(url, { ...opts, headers });
  const result = {
    url,
    finalUrl: res.url,
    status: res.status,
    size: null,
    acceptRanges: false,
    etag: res.headers.get('etag') || null,
    lastModified: res.headers.get('last-modified') || null,
    contentType: res.headers.get('content-type') || null,
    fileName: fileNameFromResponse(res),
  };
  if (res.status === 206) {
    result.acceptRanges = true;
    const cr = res.headers.get('content-range') || '';
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) result.size = Number(m[1]);
    else if (cr.startsWith('bytes 0-0/')) result.size = null;
  } else if (res.status === 200) {
    const len = res.headers.get('content-length');
    result.acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
    if (len && !result.acceptRanges) result.size = Number(len);
    else if (len && result.acceptRanges) result.size = Number(len);
  }
  // 释放连接
  try { await res.arrayBuffer(); } catch { /* ignore */ }
  return result;
}

export function fileNameFromResponse(res) {
  const cd = res.headers.get('content-disposition');
  if (cd) {
    const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
    if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ } }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    if (plain) return plain[1].trim();
  }
  try {
    const u = new URL(res.url);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (base) return base;
  } catch { /* ignore */ }
  return null;
}

async function backoff(attempt, base, retryAfter, signal) {
  let delay = Math.min(base * 2 ** attempt, 15_000);
  delay += Math.floor(Math.random() * 250); // 抖动，避免同时重试打爆
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) delay = Math.min(secs * 1000, 30_000);
  }
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, delay);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(new Error('已取消')); return; }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('已取消')); }, { once: true });
    }
  });
}

function composeSignals(a, b) {
  if (!a) return { signal: b };
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (a.aborted || b.aborted) ctrl.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: ctrl.signal };
}

/** 下载到内存（用于小文件，如 manifest.json） */
export async function fetchBuffer(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw new HttpError(`HTTP ${res.status} (${url})`, { status: res.status, url });
  return Buffer.from(await res.arrayBuffer());
}
