/**
 * 任务级下载调度：选源 → 下载 → 校验 → 失败换源重试。
 */
import fsp from 'node:fs/promises';
import { downloadSegmented } from './segment.js';
import { ariaDownload } from './aria.js';
import { verifyFile } from './verify.js';
import { fileSize } from '../util.js';

/**
 * @param {object} task
 * @param {string} task.url          主 URL
 * @param {string} task.dest         目标文件绝对路径
 * @param {number} [task.size]       期望大小（字节）
 * @param {object} [task.hashes]     期望哈希 { sha1, sha512 }
 * @param {Array}  [task.candidates] 候选源 [{url, source, mirrorId}]
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {object} ctx.logger
 * @param {'aria2'|'builtin'} ctx.engine
 * @param {AbortSignal} ctx.signal
 * @param {function} [ctx.onProgress] (downloaded, total) => void
 * @param {function} [ctx.onSource]  (info) => void   选源结果回调
 * @returns {Promise<object>} 结果
 */
export async function downloadTask(task, ctx) {
  const { config, logger, signal, onProgress, onSource } = ctx;
  const t0 = Date.now();
  const dest = task.dest;

  // —— 已存在且完整则跳过 ——
  if (task.skipExisting !== false) {
    const existing = await fileSize(dest);
    if (existing > 0) {
      const sizeOk = !task.size || existing === task.size;
      if (sizeOk) {
        if (task.hashes && config.verifyHash) {
          const v = await verifyFile(dest, task.hashes);
          if (v.ok) {
            return { status: 'skipped', path: dest, size: existing, bytes: 0, elapsed: 0, reason: v.checked ? '哈希匹配' : '大小匹配' };
          }
          logger.debug(`哈希不匹配，重新下载: ${dest}`);
          await fsp.rm(dest, { force: true });
        } else {
          return { status: 'skipped', path: dest, size: existing, bytes: 0, elapsed: 0, reason: '大小匹配' };
        }
      } else {
        logger.debug(`大小不符（${existing} ≠ ${task.size}），重新下载: ${dest}`);
        await fsp.rm(dest, { force: true });
      }
    }
  }

  // —— 选源 ——
  let candidates = task.candidates?.length ? task.candidates : [{ url: task.url, source: 'origin', mirrorId: null }];
  const originalCandidates = candidates;
  if (config.autoSelectSource && candidates.length > 1) {
    const ranker = ctx.ranker;
    if (ranker) {
      // 走缓存排序器：只有首次遇到这个"源组合"时才真正花 2 秒探测
      candidates = await ranker.rank(candidates, {
        timeout: Math.min(config.timeout, 20_000),
        signal,
        connections: ctx.connections ?? config.connections ?? 1,
        fileSize: task.size ?? null,
        minMs: config.probeMinMs,
        maxBytesPerStream: config.probeBytes,
      });
    } else {
      const { raceCandidates } = await import('./probe.js');
      const { ordered } = await raceCandidates(candidates, {
        timeout: Math.min(config.timeout, 20_000),
        signal,
        maxCandidates: config.probeCandidates,
        connections: ctx.connections ?? config.connections ?? 1,
        fileSize: task.size ?? null,
        minMs: config.probeMinMs,
        maxBytesPerStream: config.probeBytes,
      });
      candidates = ordered.map((r) => r.candidate).filter(Boolean);
    }
    const best = candidates[0];
    if (best) {
      const info = ranker ? ranker.cache.get(ranker.constructor.keyOf(originalCandidates)) : null;
      onSource?.({ url: best.url, source: best.source, order: candidates.map((c) => c.source), cached: !!info });
      logger.debug(`用源 → ${best.source}（候选顺序: ${candidates.map((c) => c.source).join(' > ')}）`);
    }
  } else if (config.autoSelectSource && candidates.length === 1) {
    onSource?.({ url: candidates[0].url, source: candidates[0].source, order: [candidates[0].source], cached: false });
  }

  // —— 按优选顺序尝试各源 ——
  //
  // 两种引擎的换源策略不同：
  //   aria2  —— 它自己支持"同一文件的多个镜像 URL"，把所有候选一次交给它，
  //             由它内部挑活的源，失败也由它自己切换，所以只跑一轮。
  //   builtin —— 不支持跨源镜像，由外层循环依次尝试每个候选源。
  const attempts = ctx.engine === 'aria2'
    ? [{ label: 'aria2 多源', urls: candidates.map((c) => c.url), source: candidates.map((c) => c.source).join(' + ') }]
    : candidates.map((c) => ({ label: c.source, urls: [c.url], source: c.source, candidate: c }));

  let lastErr;
  for (const attempt of attempts) {
    try {
      const engineOpts = {
        connections: config.connections,
        minSegmentSize: config.minSegmentSize,
        pieceSize: config.pieceSize ?? config.segmentChunk,
        stallMs: config.stallMs,
        size: task.size,
        onProgress,
        signal,
        headers: {},
        retries: config.retries,
        timeout: config.timeout,
      };
      let res;
      if (ctx.engine === 'aria2') {
        res = await ariaDownload(attempt.urls, dest, { ...engineOpts, bin: config.aria2Path });
        res.engine = 'aria2';
      } else {
        res = await downloadSegmented(attempt.urls[0], dest, engineOpts);
        res.engine = 'builtin';
      }

      // —— 校验 ——
      let verified = { checked: false, ok: true };
      if (task.hashes && config.verifyHash) {
        verified = await verifyFile(dest, task.hashes);
        if (!verified.ok) {
          await fsp.rm(dest, { force: true });
          throw new Error(`哈希校验失败（${verified.algo}: 期望 ${verified.expected?.slice(0, 12)}… 实际 ${verified.actual?.slice(0, 12)}…）`);
        }
      }

      const elapsed = (Date.now() - t0) / 1000;
      return {
        status: 'done',
        path: dest,
        size: res.size,
        bytes: res.bytes,
        elapsed,
        speed: elapsed > 0 ? res.bytes / elapsed : 0,
        engine: res.engine,
        connections: res.connections,
        resumed: res.resumed,
        source: attempt.source,
        url: attempt.urls[0],
        verified,
      };
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw new Error('已取消');
      logger.debug(`源失败 [${attempt.label}] ${err.message}`);
      // 用源失败 → 作废该源组合的缓存，下次重新实测（可能这条源只是临时抖动）
      ctx.ranker?.invalidate(originalCandidates);
      // 换下一个源继续尝试
    }
  }
  throw new Error(`所有下载源均失败: ${lastErr?.message ?? '未知错误'}`);
}
