/**
 * 多连接分片下载引擎。
 *
 * 核心不是"把文件切成 N 段各下各的"，而是**小分片 + 动态工作队列**。
 *
 * 为什么必须这样做（实测教训）：
 * 最初给每条连接静态分配一大段（如 200MB 文件切 8 段、每段 24MB）。实测发现
 * CDN 会**饿死其中大部分连接** —— 抓到的每段字节分布是 `[0/0/0/0/0/24/0/0]`，
 * 只有一两条连接拿到带宽，其余一直是 0。静态分段下，那条被饿死的连接所负责的
 * 24MB 永远下不完，整个文件就卡住了；而拿到带宽的连接干完自己的活也只能闲着。
 * 同一文件、同样 8 连接，aria2c 能跑 21 MB/s，静态分段只有 7.7 MB/s。
 *
 * 改成小分片（默认 2MB）+ 共享待办队列后：
 *   - 被饿死的连接拿不到数据 → 由看门狗判定停滞 → 把分片退回队列 → 它去领下一片
 *   - 健康的连接干完一片立刻领下一片，不会闲着
 * 也就是 aria2 的做法：谁跑得快谁多干活。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { request, probeRemote, HttpError } from '../net/http.js';

const PROGRESS_INTERVAL_MS = 150;
const STATE_VERSION = 2;

/** 默认分片大小 */
export const DEFAULT_PIECE_SIZE = 2 * 1024 * 1024;
/** 分片数上限，避免超大文件把状态文件撑爆 */
const MAX_PIECES = 4096;
/** 单条连接多久没收到数据就判定为被饿死，退回分片换人 */
const DEFAULT_STALL_MS = 12_000;

/**
 * 规划静态分片（保留此接口：小文件、以及需要固定分段时使用）
 */
export function planSegments(size, { connections, minSegmentSize, segmentChunk }) {
  if (!size || size <= 0 || size < minSegmentSize || connections <= 1) {
    return [{ index: 0, start: 0, end: size > 0 ? size - 1 : -1, downloaded: 0, done: false }];
  }
  const maxByChunk = Math.max(1, Math.floor(size / segmentChunk));
  const n = Math.max(1, Math.min(connections, maxByChunk));
  const per = Math.ceil(size / n);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const start = i * per;
    if (start >= size) break;
    const end = Math.min(start + per - 1, size - 1);
    segs.push({ index: i, start, end, downloaded: 0, done: false });
  }
  return segs;
}

/**
 * 规划分片队列：切成大小均匀的小片，供动态调度。
 * @returns {{index:number,start:number,end:number,downloaded:number,done:boolean}[]}
 */
export function planPieces(size, { pieceSize = DEFAULT_PIECE_SIZE } = {}) {
  if (!size || size <= 0) return [{ index: 0, start: 0, end: -1, downloaded: 0, done: false }];
  const ps = Math.max(64 * 1024, Math.min(pieceSize, Math.ceil(size / 1) || pieceSize));
  const count = Math.min(MAX_PIECES, Math.max(1, Math.ceil(size / ps)));
  const per = Math.ceil(size / count);
  const pieces = [];
  for (let i = 0; i < count; i++) {
    const start = i * per;
    if (start >= size) break;
    const end = Math.min(start + per - 1, size - 1);
    pieces.push({ index: i, start, end, downloaded: 0, done: false });
  }
  return pieces;
}

function statePathFor(destPath) { return `${destPath}.mcboost`; }

async function readState(destPath) {
  try { return JSON.parse(await fsp.readFile(statePathFor(destPath), 'utf8')); }
  catch { return null; }
}

async function writeState(destPath, state) {
  const tmp = `${statePathFor(destPath)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fsp.rename(tmp, statePathFor(destPath));
}

/**
 * 下载单个 URL 到 destPath。
 *
 * @param {string} url
 * @param {string} destPath
 * @param {object} opts
 * @param {number} [opts.size]           已知文件大小（省一次探测）
 * @param {number} [opts.connections]    并发连接数
 * @param {number} [opts.pieceSize]      分片大小
 * @param {number} [opts.stallMs]        连接停滞多久就换人
 * @param {number} [opts.minSegmentSize] 小于此值不分片
 * @param {boolean}[opts.resume=true]    复用已有 .part
 * @param {function}[opts.onProgress]    (downloaded, total) => void
 * @param {AbortSignal} [opts.signal]
 */
export async function downloadSegmented(url, destPath, opts = {}) {
  const {
    size: knownSize,
    connections = 8,
    minSegmentSize = 1 * 1024 * 1024,
    segmentChunk,
    pieceSize = segmentChunk ?? DEFAULT_PIECE_SIZE,
    stallMs = DEFAULT_STALL_MS,
    resume = true,
    onProgress,
    signal,
    headers = {},
    maxPieceAttempts = 6,
    timeout = 45_000,
  } = opts;

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;

  // —— 1. 探测远端 ——
  // 探测只是为了知道「文件多大」「支不支持 Range」。它失败**不应该**让下载失败：
  // 有些 CDN 会挂起连接（实测遇到过），那样会白等 timeout×retries 才报错，
  // 而一次普通 GET 其实可能完全正常。所以探测失败就退回单连接下载。
  let meta = { size: knownSize ?? null, acceptRanges: false, etag: null };
  let probeFailed = false;
  try {
    const probe = await probeRemote(url, {
      headers,
      timeout: Math.min(timeout, 20_000),
      retries: 1,
      signal,
    });
    if (probe.status !== 200 && probe.status !== 206) {
      throw new HttpError(`HTTP ${probe.status}，无法下载`, { status: probe.status, url });
    }
    meta.acceptRanges = probe.acceptRanges || probe.status === 206;
    if (probe.size) meta.size = probe.size;
    meta.etag = probe.etag;
  } catch (err) {
    if (signal?.aborted) throw err;
    // 明确的客户端错误（404/403 等）直接上抛，别浪费一次完整请求
    if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
      throw err;
    }
    probeFailed = true;
  }

  const total = meta.size;
  const canPiece = !probeFailed && meta.acceptRanges && total && total >= minSegmentSize && connections > 1;

  if (!canPiece) {
    return downloadSingle(url, destPath, partPath, { ...opts, knownSize: total, onProgress, signal, headers, timeout });
  }

  // —— 2. 分片与断点续传状态 ——
  let pieces = planPieces(total, { pieceSize });
  let resumed = false;
  const partSize = await fsp.stat(partPath).then((s) => s.size, () => 0);
  if (resume && partSize > 0) {
    const st = await readState(destPath);
    const compatible = st && st.v === STATE_VERSION && st.url === url && st.size === total
      && st.pieceSize && Array.isArray(st.done) && Array.isArray(st.dl) && st.dl.length === pieces.length;
    if (compatible) {
      for (let i = 0; i < pieces.length; i++) {
        pieces[i].downloaded = Math.min(st.dl[i] || 0, pieces[i].end - pieces[i].start + 1);
        pieces[i].done = !!st.done[i] || pieces[i].downloaded >= pieces[i].end - pieces[i].start + 1;
      }
      resumed = pieces.some((p) => p.done || p.downloaded > 0);
    } else {
      await fsp.rm(partPath, { force: true });
    }
  } else if (partSize > 0) {
    await fsp.rm(partPath, { force: true });
  }

  // —— 3. 共享待办队列（动态调度的核心） ——
  const pending = [];
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (!pieces[i].done) pending.push(i);
  }
  const attempts = new Array(pieces.length).fill(0);

  let downloaded = pieces.reduce((a, p) => a + (p.done ? p.end - p.start + 1 : p.downloaded), 0);

  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    onProgress?.(downloaded, total);
  };

  const fh = await fsp.open(partPath, partSize > 0 ? 'r+' : 'w+');
  const state = {
    v: STATE_VERSION, url, size: total, etag: meta.etag, pieceSize,
    done: pieces.map((p) => p.done),
    dl: pieces.map((p) => p.downloaded),
    startedAt: Date.now(),
  };
  let dirty = false;
  const persist = async () => {
    dirty = false;
    state.done = pieces.map((p) => p.done);
    state.dl = pieces.map((p) => p.downloaded);
    await writeState(destPath, state).catch(() => {});
  };
  const stateTimer = setInterval(() => { if (dirty) persist(); }, 1500);

  const workerCount = Math.max(1, Math.min(connections, pending.length || 1));

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new Error('已取消');
      const idx = pending.pop();
      if (idx === undefined) return;          // 队列空了，收工
      const piece = pieces[idx];
      if (piece.done) continue;

      try {
        // 每次领取只下一次 Range 请求；被饿死就退回队列换人
        const got = await pullPiece(fh, url, piece, { headers, signal, timeout, stallMs });
        piece.downloaded += got;
        downloaded += got;
        dirty = true;
        emit();
      } catch (err) {
        if (signal?.aborted) throw new Error('已取消');
        if (err instanceof HttpError && (err.status === 200 || (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429))) {
          throw err; // 明确的"不支持 Range"或客户端错误，直接上抛
        }
        // 其它情况：把分片退回队列，让别的连接来试
      }

      if (piece.downloaded >= piece.end - piece.start + 1) {
        piece.done = true;
      } else {
        attempts[idx]++;
        if (attempts[idx] > maxPieceAttempts) {
          throw new Error(`分片 #${idx} 重试 ${maxPieceAttempts} 次仍未完成（${piece.downloaded}/${piece.end - piece.start + 1} 字节）`);
        }
        // 退避一下再放回队列，避免所有连接同时抢同一个卡住的分片
        await sleep(Math.min(300 * attempts[idx], 3000), signal);
        pending.unshift(idx);
      }
      dirty = true;
    }
  };

  try {
    emit(true);
    await Promise.all(new Array(workerCount).fill(0).map(() => worker()));
    clearInterval(stateTimer);
    await persist();
  } catch (err) {
    clearInterval(stateTimer);
    await persist();
    await fh.close().catch(() => {});
    throw err;
  }
  await fh.close();

  // —— 4. 完整性以字节计数器为准 ——
  // 分片是按偏移写入的稀疏文件，只要最后一片写了开头，文件长度就等于总长，
  // 中间却可能还有空洞，所以不能只看文件长度。
  const accounted = pieces.reduce((a, p) => a + Math.min(p.downloaded, p.end - p.start + 1), 0);
  if (accounted !== total) {
    throw new Error(`下载不完整：分片累计 ${accounted} 字节，期望 ${total} 字节`);
  }
  const missing = pieces.filter((p) => !p.done);
  if (missing.length) {
    throw new Error(`仍有 ${missing.length} 个分片未完成`);
  }

  await fsp.rename(partPath, destPath);
  await fsp.rm(statePathFor(destPath), { force: true });
  emit(true);

  return { path: destPath, size: total, bytes: downloaded, connections: workerCount, pieces: pieces.length, resumed };
}

/**
 * 拉取一个分片剩余的部分。
 *
 * 带看门狗：只要在 stallMs 内没有任何进展（**包括迟迟不给响应头**），
 * 就主动断开并返回，让这个分片回到队列被别的连接领走 ——
 * 这是应对"CDN 饿死部分连接"的关键。
 *
 * 注意看门狗必须在发起请求**之前**就装上：只覆盖收数据阶段是不够的，
 * 有些被饿死的连接是"连接建立了但永远不返回响应头"，
 * 那种情况要等满整个 timeout 才会放弃，会把下载卡死。
 *
 * @returns {Promise<number>} 本次实际写入的字节数
 */
async function pullPiece(fh, url, piece, { headers, signal, timeout, stallMs }) {
  const pieceSize = piece.end - piece.start + 1;
  if (piece.downloaded >= pieceSize) return 0;
  const from = piece.start + piece.downloaded;

  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw new Error('已取消');
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let wrote = 0;
  let pos = from;
  let stalled = false;
  let res = null;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { stalled = true; ctrl.abort(); }, stallMs);
  };
  let watchdog = null;
  armWatchdog(); // 先于请求装上，覆盖"等响应头"阶段

  try {
    res = await request(url, {
      headers: { ...headers, Range: `bytes=${from}-${piece.end}` },
      timeout, retries: 0, signal: ctrl.signal,
    });
    if (res.status === 200) {
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      throw new HttpError('服务器忽略了 Range 请求，改用单连接', { status: 200, url });
    }
    if (res.status !== 206) {
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      throw new HttpError(`分片请求返回 HTTP ${res.status}`, { status: res.status, url });
    }

    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      armWatchdog(); // 每收到一块数据就重置

      const remain = piece.end - pos + 1;
      const chunk = value.length > remain ? value.subarray(0, remain) : value;
      await fh.write(chunk, 0, chunk.length, pos);
      pos += chunk.length;
      wrote += chunk.length;
      if (pos > piece.end) break;
    }
  } catch (err) {
    if (signal?.aborted) throw new Error('已取消');
    if (!stalled) {
      // 真实错误：已经写了一些数据就当作部分成功（下次续传），否则上抛
      if (wrote === 0) throw err;
    }
  } finally {
    clearTimeout(watchdog);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
    try { await res?.body?.cancel?.(); } catch { /* ignore */ }
  }
  return wrote;
}

/** 单连接下载（服务器不支持 Range / 文件很小） */
async function downloadSingle(url, destPath, partPath, opts) {
  const { onProgress, signal, headers = {}, retries = 4, timeout = 45_000, knownSize } = opts;
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    if (signal?.aborted) throw new Error('已取消');
    try {
      const existing = await fsp.stat(partPath).then((s) => s.size, () => 0);
      const startAt = existing > 0 ? existing : 0;
      const res = await request(url, {
        headers: startAt > 0 ? { ...headers, Range: `bytes=${startAt}-` } : headers,
        timeout, retries: 0, signal,
      });
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`, { status: res.status, url });
      const appending = startAt > 0 && res.status === 206;
      const total = knownSize ?? (() => {
        const len = res.headers.get('content-length');
        return len ? Number(len) + (appending ? startAt : 0) : null;
      })();
      let downloaded = appending ? startAt : 0;
      const fh = await fsp.open(partPath, appending ? 'r+' : 'w+');
      try {
        const reader = res.body.getReader();
        let pos = downloaded;
        let lastEmit = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          await fh.write(value, 0, value.length, pos);
          pos += value.length;
          downloaded += value.length;
          const now = Date.now();
          if (now - lastEmit > PROGRESS_INTERVAL_MS) { lastEmit = now; onProgress?.(downloaded, total); }
        }
      } finally {
        await fh.close();
      }
      const finalSize = await fsp.stat(partPath).then((s) => s.size, () => -1);
      if (total && finalSize !== total) throw new Error(`下载不完整：${finalSize}/${total}`);
      await fsp.rename(partPath, destPath);
      onProgress?.(finalSize, finalSize);
      return { path: destPath, size: finalSize, bytes: finalSize, connections: 1, pieces: 1, resumed: startAt > 0 };
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && err.status && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) throw err;
      attempt++;
      if (attempt > retries) break;
      await sleep(Math.min(800 * 2 ** (attempt - 1), 8000), signal);
    }
  }
  throw new Error(`下载失败: ${lastErr?.message ?? '未知错误'}`);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(new Error('已取消')); return; }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('已取消')); }, { once: true });
    }
  });
}
