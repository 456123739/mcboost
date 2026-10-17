/**
 * 多源测速选源。
 *
 * 设计要点（都是实测踩出来的）：
 *
 * 1. **按实际使用方式测速**：同一条源，单连接与 8 连接分片的速度可能差 10 倍以上
 *    （实测 Mojang 官方源：单连接 308 KB/s，16 连接 4.0 MB/s）。所以对支持 Range
 *    且文件足够的候选源，直接用多连接并发探测，量它真正能跑到的聚合吞吐。
 *
 * 2. **必须按时间探测，不能按固定字节数**：用 256KB 去测，量到的基本是 TCP 慢启动
 *    和握手延迟 —— 实测同一条 BMCLAPI 源，256KB 探针得出 0.16 MB/s，
 *    而连续下载 12MB 时是 3.9 MB/s，差 24 倍。所以这里让每条流至少跑 `minMs`
 *    毫秒（默认 2 秒），达到稳态后再算吞吐。
 *
 * 3. **结果按"源组合"缓存**：选源结论是主机对之间的属性，不是单个文件的属性。
 *    整合包里几百个文件都来自同几个 CDN，只探测一次即可，否则光探测就要几分钟。
 */
import { request } from '../net/http.js';

/** 默认探测参数 */
export const PROBE_DEFAULTS = {
  minMs: 2000,              // 每条流至少跑这么久，避开 TCP 慢启动
  maxBytesPerStream: 1.5 * 1024 * 1024, // 单流最多读这么多，防止探测吃带宽
  maxMs: 12_000,            // 硬上限
  timeout: 20_000,
};

/**
 * 测量单个源的下载吞吐（自动决定单流还是多流探测）。
 *
 * @returns {{url, ok, bytes, ms, bps, ttfb, supportsRange, size, streams, error?}}
 */
export async function measureSource(url, opts = {}) {
  const {
    streams = 1,
    timeout = PROBE_DEFAULTS.timeout,
    headers = {},
    signal,
    minMs = PROBE_DEFAULTS.minMs,
    maxBytesPerStream = PROBE_DEFAULTS.maxBytesPerStream,
    maxMs = PROBE_DEFAULTS.maxMs,
    minSizeForMultiStream = 512 * 1024,
  } = opts;

  const t0 = Date.now();
  try {
    // 先用 1 字节 Range 请求确认是否支持分片，并拿到文件大小
    const probe = await request(url, {
      headers: { ...headers, Range: 'bytes=0-0' },
      timeout, retries: 0, signal,
    });
    const supportsRange = probe.status === 206;
    const cr = probe.headers.get('content-range') || '';
    const m = /\/(\d+)\s*$/.exec(cr);
    const size = m ? Number(m[1]) : null;
    try { await probe.arrayBuffer(); } catch { /* ignore */ }
    if (!probe.ok && probe.status !== 206) {
      return { url, ok: false, bytes: 0, ms: Date.now() - t0, bps: 0, ttfb: 0, supportsRange, size, streams: 0, error: `HTTP ${probe.status}` };
    }
    const ttfb = Date.now() - t0;

    const canMulti = supportsRange && streams > 1 && (size === null || size >= minSizeForMultiStream);
    const nStreams = canMulti ? streams : 1;

    // 每条流负责一段足够长的区间，然后"跑满 minMs 或读满配额"再结算
    const totalWanted = maxBytesPerStream * nStreams;
    const span = size === null ? totalWanted : Math.min(totalWanted, size);
    const per = Math.max(1, Math.ceil(span / nStreams));

    const t1 = Date.now();
    const parts = await Promise.all(new Array(nStreams).fill(0).map((_, i) => {
      const start = i * per;
      if (size !== null && start >= size) return Promise.resolve({ bytes: 0, ms: 1 });
      const end = size === null ? start + per - 1 : Math.min(start + per - 1, size - 1);
      return pullTimed(url, { start, end }, { headers, timeout, signal, minMs, maxMs });
    }));
    const got = parts.reduce((a, p) => a + p.bytes, 0);
    // 以最慢的一条流为准：聚合吞吐受它限制
    const ms = Math.max(1, Math.max(...parts.map((p) => p.ms)));
    return {
      url,
      ok: got > 0,
      bytes: got,
      ms,
      bps: got > 0 ? (got / ms) * 1000 : 0,
      ttfb,
      supportsRange,
      size,
      streams: parts.filter((p) => p.bytes > 0).length,
    };
  } catch (err) {
    return {
      url, ok: false, bytes: 0, ms: Date.now() - t0, bps: 0, ttfb: 0,
      supportsRange: false, size: null, streams: 0,
      error: err?.cause?.code || err.message,
    };
  }
}

/**
 * 拉取一个区间，至少跑 minMs 毫秒（或读满配额 / 触到 maxMs）再返回。
 * 这是为了避开 TCP 慢启动：小样本测出来的吞吐毫无参考价值。
 */
async function pullTimed(url, { start, end }, { headers = {}, timeout, signal, minMs, maxMs }) {
  const t0 = Date.now();
  try {
    const res = await request(url, {
      headers: { ...headers, Range: `bytes=${start}-${end}` },
      timeout, retries: 0, signal,
    });
    if (!res.ok && res.status !== 206) {
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      return { bytes: 0, ms: Date.now() - t0, error: `HTTP ${res.status}` };
    }
    const quota = end - start + 1;
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value?.length ?? 0;
      const el = Date.now() - t0;
      if (got >= quota) break;
      if (el >= maxMs) break;
      // 跑够 minMs 且已经拿到有意义的数据量才收工
      if (el >= minMs && got >= 256 * 1024) break;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return { bytes: got, ms: Math.max(1, Date.now() - t0) };
  } catch (err) {
    return { bytes: 0, ms: Math.max(1, Date.now() - t0), error: err?.cause?.code || err.message };
  }
}

/** 兼容旧接口：单流测速 */
export function measure(url, opts = {}) {
  return measureSource(url, { ...opts, streams: 1 });
}

/** 并发测量一组候选源，返回按实测吞吐排序的结果 */
export async function rankOnce(candidates, opts = {}) {
  const {
    timeout, headers = {}, signal, connections = 1, fileSize = null,
    minMs, maxBytesPerStream, maxMs,
  } = opts;
  const streams = fileSize && fileSize >= 2 * 1024 * 1024 ? Math.max(1, Math.min(4, connections)) : 1;
  const results = await Promise.all(candidates.map((c) => measureSource(c.url, {
    streams, timeout, headers, signal, minMs, maxBytesPerStream, maxMs,
  })));
  const scored = results.map((r, i) => {
    const cand = candidates[i];
    // 吞吐为主，首字节延迟做轻微惩罚，避免"带宽高但握手巨慢"的源在小文件上拖后腿
    const penalty = r.ok ? 1 / (1 + (r.ttfb ?? 0) / 4000) : 0;
    return { ...r, candidate: cand, score: (r.bps || 0) * (0.75 + 0.25 * penalty) };
  });
  const usable = scored.filter((r) => r.ok).sort((a, b) => b.score - a.score);
  const failed = scored.filter((r) => !r.ok);
  return { ordered: [...usable, ...failed], usable, failed, results: scored };
}

/**
 * 选源排序器：把"哪个源快"的结论按源组合缓存起来。
 *
 * 整合包里几百个文件往往来自同几个 CDN，每个文件都探测一遍纯属浪费
 * （每轮探测要 2 秒以上）。这里按 (候选源集合 + 起始主机) 做键缓存排序结论，
 * 只在首次遇到某组合时真正探测。失败时可通过 invalidate() 让它重新探测。
 */
export class SourceRanker {
  constructor({ logger, stats = {} } = {}) {
    this.cache = new Map();
    this.logger = logger;
    this.stats = stats;
    this.probes = 0;
    this.hits = 0;
  }

  static keyOf(candidates) {
    let host = '';
    try { host = new URL(candidates[0].url).host; } catch { /* ignore */ }
    return `${host}|${candidates.map((c) => c.source).join(',')}`;
  }

  /** 返回排好序的候选列表（最快的在前） */
  async rank(candidates, opts = {}) {
    if (candidates.length <= 1 || opts.disabled) return candidates;
    const key = SourceRanker.keyOf(candidates);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      // 用缓存顺序重排当前候选（候选集合可能略有不同）
      const order = new Map(cached.map((s, i) => [s, i]));
      return [...candidates].sort((a, b) => (order.get(a.source) ?? 99) - (order.get(b.source) ?? 99));
    }
    this.probes++;
    const { ordered, usable, failed } = await rankOnce(candidates, opts);
    if (usable.length) {
      const order = ordered.map((r) => r.candidate.source);
      this.cache.set(key, order);
      this.logger?.debug?.(
        `选源探测 [${key}] → ${ordered.slice(0, 3).map((r) => `${r.candidate.source} ${r.ok ? `${(r.bps / 1048576).toFixed(2)}MB/s@${r.streams}流` : '×'}`).join('  ')}`
      );
    } else {
      this.logger?.debug?.(`选源探测 [${key}] 全部候选不可用，回退到主源`);
    }
    if (failed.length && failed.length === candidates.length) return candidates;
    return ordered.map((r) => r.candidate);
  }

  /** 某个源的下载失败了，作废相关缓存，下次重新探测 */
  invalidate(candidates) {
    if (!candidates?.length) return;
    this.cache.delete(SourceRanker.keyOf(candidates));
  }

  get size() { return this.cache.size; }
}

/** 旧接口保留：单次竞速（等价于 rankOnce 后取最优） */
export async function raceCandidates(candidates, opts = {}) {
  const { maxCandidates = 3 } = opts;
  const list = candidates.slice(0, Math.max(1, maxCandidates));
  const { ordered, results } = await rankOnce(list, opts);
  return { best: ordered[0]?.candidate ?? list[0], results, ordered };
}
