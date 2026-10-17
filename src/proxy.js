/**
 * 本地加速代理（mcboost proxy）。
 *
 * 用途：让 PCL2 / PCL CE 这类启动器的下载走本地多连接分片加速，
 *      而不需要改动启动器本身。
 *
 * 背景（读 PCL2 / PCL CE 源码后的结论）：
 *   - PCL 的下载引擎已有分片能力，但有几处硬限制：
 *       1. URL 含 `bmclapi` / `github.com` / `optifine.net` / `momot.rs` /
 *          `meloong.com` / `pcl2-server` 等关键词时**强制单线程**
 *          （ModNet.vb 的 TryBeginThread 黑名单）。
 *       2. 全局线程上限 NetTaskThreadLimit = 设置项 + 1，所有文件共享。
 *       3. 分片是渐进式的，要等某个碎片超过 FilePieceLimit 才开新线程。
 *   - 所以给 PCL 配国内镜像（BMCLAPI 之类）反而会让模组全部退化成单连接，
 *     这是"明明开了镜像还慢"的隐形原因。
 *
 * 本代理的做法：
 *   - PCL 把下载源指向 http://127.0.0.1:8788/，PCL 就会把文件请求发到这里。
 *   - 代理识别 URL 里的真实目标（支持几种编码形式），用 mcboost 的
 *     多连接分片引擎下载，再把字节流回给 PCL。
 *   - 因为分片请求全部发生在**代理内部**（对 PCL 而言只是一次普通
 *     单连接 GET），PCL 的线程黑名单和线程上限完全不影响实际吞吐。
 *
 * 支持的 URL 形式：
 *   /<scheme>/<host>/<path>             例：/https/cdn.modrinth.com/data/xxx.jar
 *   /d/<base64url 的目标 URL>           例：/d/aHR0cHM6Ly9jZG4ubW9kcmludGguY29tLw==
 *   裸路径 + Host 头                    例：GET /data/xxx.jar，Host: cdn.modrinth.com
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { downloadSegmented } from './engine/segment.js';
import { request, DEFAULT_UA } from './net/http.js';
import { candidatesFor } from './mirrors.js';
import { fileSize } from './util.js';

/** PCL 会强制单线程的关键词；代理内部下载时要避开这些子串出现在对外 URL 上 */
const PCL_BLACKLIST = ['pcl2-server', 'meloong.com', 'bmclapi', 'github.com', 'optifine.net', 'momot.rs'];

/** 把目标 URL 编码成 PCL 可用的本地地址 */
export function encodeTarget(targetUrl) {
  return `http://127.0.0.1:${PROXY_PORT_DEFAULT}/d/${Buffer.from(targetUrl, 'utf8').toString('base64url')}`;
}
export const PROXY_PORT_DEFAULT = 8788;

/** 从请求里解析出真实目标 URL */
export function resolveTarget(req, urlPath) {
  // 形式 1：/d/<base64url>
  if (urlPath.startsWith('/d/')) {
    try {
      return { url: Buffer.from(urlPath.slice(3), 'base64url').toString('utf8'), how: 'encoded' };
    } catch { /* fall through */ }
  }
  // 形式 2：/<scheme>/<host>/<path...>
  const m = /^\/(https?)\/([^/]+)(\/.*)?$/i.exec(urlPath);
  if (m) {
    const scheme = m[1].toLowerCase();
    const host = m[2];
    const rest = m[3] ?? '/';
    return { url: `${scheme}://${host}${rest}`, how: 'scheme' };
  }
  // 形式 3：裸路径 + Host 头
  const host = req.headers.host;
  if (host && !/^127\.0\.0\.1|^localhost|^\[::1\]/i.test(host)) {
    const scheme = req.headers['x-forwarded-proto'] || 'https';
    return { url: `${scheme}://${host}${urlPath}`, how: 'host' };
  }
  return null;
}

/** 目标 URL 是否命中 PCL 的单线程黑名单（仅用于日志提示） */
export function hitsPclBlacklist(targetUrl) {
  const lower = String(targetUrl).toLowerCase();
  return PCL_BLACKLIST.filter((k) => lower.includes(k));
}

export async function startProxy({ port = PROXY_PORT_DEFAULT, config, logger } = {}) {
  const cacheDir = path.join(config?.cacheDir ?? '/tmp/mcboost-proxy-cache', 'files');
  await fsp.mkdir(cacheDir, { recursive: true });

  const stats = {
    requests: 0,
    accelerated: 0,
    direct: 0,
    bytes: 0,
    errors: 0,
    startedAt: Date.now(),
    recent: [],
  };

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    stats.requests++;
    let target;
    try {
      const u = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      // 健康检查 / 统计（必须在 resolveTarget 之前判断，
      // 否则 /ping 会被当成目标地址而解析失败）
      if (u.pathname === '/' || u.pathname === '/ping' || u.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, service: 'mcboost-proxy', stats: summary() }, null, 2));
        return;
      }

      target = resolveTarget(req, u.pathname + (u.search ?? ''));
      if (!target) throw new Error(`无法从请求解析目标地址: ${req.url}`);
      if (!/^https?:\/\//i.test(target.url)) throw new Error(`目标地址不合法: ${target.url}`);

      const targetUrl = target.url;
      const black = hitsPclBlacklist(targetUrl);
      if (black.length) {
        logger?.debug?.(`注意：目标命中 PCL 单线程黑名单关键词 [${black.join(',')}]，但代理内部不受影响`);
      }

      // —— 下载到缓存（多连接分片），再回给 PCL ——
      const cacheKey = Buffer.from(targetUrl).toString('base64url');
      const dest = path.join(cacheDir, cacheKey);

      const already = await fileSize(dest);
      if (already > 0) {
        logger?.debug?.(`命中代理缓存: ${path.basename(new URL(targetUrl).pathname)}`);
        await streamFile(res, dest, already, req);
        stats.accelerated++;
        stats.bytes += already;
        stats.recent.push({ url: targetUrl, cached: true, ms: Date.now() - t0, size: already });
        return;
      }

      // —— 边下边传 ——
      // 不能等整个文件下完再回传：PCL 的单文件超时只有 10~30 秒，
      // 一个几百 MB 的文件如果先下完再传，客户端会连续几十秒收不到任何字节，
      // PCL 会判定为卡死并切换下载源。
      // 所以这里起"后台多连接下载 + 本地顺序读取回传"的管道：
      // 下载引擎把字节写进 .part（乱序），读取端按 0..N 顺序读出并立刻回给客户端。
      const engineOpts = {
        connections: config?.connections ?? 16,
        minSegmentSize: config?.minSegmentSize ?? 1 * 1024 * 1024,
        pieceSize: config?.pieceSize ?? 512 * 1024,
        stallMs: config?.stallMs ?? 12_000,
        timeout: config?.timeout ?? 60_000,
        retries: config?.retries ?? 4,
      };
      const candidates = candidatesFor(targetUrl, config ?? {});

      // 小文件不值得走分片管道：分片管道的启动开销（探测 + 起后台下载 +
      // 等 .part 出现）就要几百毫秒，对 1MB 以下的文件反而是净亏。
      // 直接单连接转发，延迟最低。阈值默认 4MB。
      const smallFileThreshold = config?.smallFileThreshold ?? 4 * 1024 * 1024;
      const knownSize = await fileSize(dest);
      if (knownSize > 0 && knownSize <= smallFileThreshold) {
        logger?.debug?.(`小文件直连转发: ${path.basename(new URL(targetUrl).pathname)} (${knownSize}B)`);
        stats.direct++;
        return streamFile(res, dest, knownSize, req);
      }

      let piped = false;
      let lastErr;
      for (const cand of candidates.slice(0, 3)) {
        try {
          await streamWhileDownloading(cand.url, dest, engineOpts, res, logger);
          piped = true;
          break;
        } catch (err) {
          lastErr = err;
          logger?.debug?.(`代理加速失败 [${cand.source}]: ${err.message}`);
          // 换下一个候选源重试
        }
      }
      if (!piped) {
        // 兜底：直接转发，绝不让 PCL 卡死
        logger?.warn?.(`加速下载失败，退回直接转发: ${lastErr?.message}`);
        stats.direct++;
        if (res.headersSent || res.writableEnded) {
          // 响应头已经发出，不能再转发，只能结束响应
          logger?.error?.(`响应已开始，无法回退转发: ${lastErr?.message}`);
          try { res.end(); } catch { /* ignore */ }
          return;
        }
        return pipeDirect(targetUrl, req, res, stats, logger);
      }
      stats.accelerated++;
      const finalSize = await fileSize(dest);
      stats.bytes += finalSize;
      stats.recent.push({ url: targetUrl, cached: false, ms: Date.now() - t0, size: finalSize, engine: 'builtin-stream' });
      if (stats.recent.length > 50) stats.recent.shift();
      return;
    } catch (err) {
      stats.errors++;
      logger?.error?.(`代理错误: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`mcboost proxy error: ${err.message}`);
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  // 支持 CONNECT（HTTPS 隧道）—— 有些启动器会直接请求 https://
  server.on('connect', (req, clientSocket, head) => {
    const [hostPort] = (req.url ?? '').split(':');
    logger?.debug?.(`CONNECT ${req.url}（HTTPS 隧道，转发到 ${hostPort}）`);
    const upstream = https.request({ host: hostPort, port: 443, method: 'CONNECT', path: req.url });
    upstream.on('connect', (upRes, upSocket) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upSocket.write(head);
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
    });
    upstream.on('error', () => { try { clientSocket.end(); } catch { /* ignore */ } });
    upstream.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  function summary() {
    const el = (Date.now() - stats.startedAt) / 1000;
    return {
      ...stats,
      elapsed: Math.round(el),
      avgSpeed: el > 0 ? Math.round(stats.bytes / el) : 0,
      cacheDir,
    };
  }

  logger?.info('');
  logger?.info(`\x1b[1m mcboost 加速代理已启动 \x1b[0m`);
  logger?.info(`   地址     : http://127.0.0.1:${port}`);
  logger?.info(`   缓存目录 : ${cacheDir}`);
  logger?.info('');
  logger?.info('   在 PCL2 / PCL CE 中设置下载源为该地址即可获得加速，例如：');
  logger?.info(`     ${encodeTarget('https://cdn.modrinth.com/').replace(/\/$/, '')}`);
  logger?.info('');
  logger?.info(`   健康检查 : curl http://127.0.0.1:${port}/ping`);
  return { server, port, summary, stats };
}

/**
 * 边下边传。
 *
 * 难点：分片下载是**乱序**写入 .part 的（谁先连上谁先写），
 * 但 HTTP 响应体必须按 0..N 顺序发给客户端。
 *
 * 解法：起一个后台下载任务（不 await），主协程按偏移顺序读 .part：
 *   - 读之前先 peek 一下目标偏移处是否已有数据
 *   - 没有就等一小会儿（`pollMs`）再试
 *   - 下载整体完成或失败时收尾
 * 这样客户端能立刻开始收字节，不会因为"先下完再传"而被 PCL 判超时。
 *
 * @param {string} url        目标 URL
 * @param {string} dest       .part 文件的最终路径（不含 .part）
 * @param {object} engineOpts 传给下载引擎的参数
 * @param {import('node:http').ServerResponse} res 要写入的响应
 */
async function streamWhileDownloading(url, dest, engineOpts, res, logger = null) {
  const partPath = `${dest}.part`;

  // 探测大小与是否支持 Range（顺带复用下载引擎的探测逻辑）
  const probe = await request(url, {
    headers: { Range: 'bytes=0-0' },
    timeout: 20_000,
    retries: 1,
  });
  if (probe.status !== 200 && probe.status !== 206) {
    try { await probe.arrayBuffer(); } catch { /* ignore */ }
    throw new Error(`HTTP ${probe.status}`);
  }
  const cr = probe.headers.get('content-range') || '';
  const m = /\/(\d+)\s*$/.exec(cr);
  const totalSize = m ? Number(m[1]) : null;
  try { await probe.arrayBuffer(); } catch { /* ignore */ }
  if (!totalSize) {
    // 拿不到大小就不分片，直接转发（streamWhileDownloading 需要知道长度）
    throw new Error('无法获取文件大小，退回直接转发');
  }

  // 后台启动下载（不阻塞）
  const dlDone = downloadSegmented(url, dest, engineOpts).then(
    () => 'ok',
    (err) => { throw err; }
  );
  // 防止未处理的 rejection
  dlDone.catch(() => {});

  // 发送响应头（不带 Content-Length，用分块编码）
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Transfer-Encoding': 'chunked',
    'Accept-Ranges': 'bytes',
    'X-Mcboost-Accelerated': '1',
  });

  const CHUNK = 512 * 1024;
  const pollMs = 12;
  let sent = 0;
  // 下载可能在读取端开始前就已完成并 rename 掉 .part，所以两个路径都要能读。
  // 而且下载刚启动，.part 可能还没被创建，需要轮询等它出现。
  let fh = null;
  let readPath = null;
  for (let i = 0; i < 1000 && !fh; i++) {
    fh = await fsp.open(partPath, 'r').catch(() => null);
    if (fh) { readPath = partPath; break; }
    fh = await fsp.open(dest, 'r').catch(() => null);
    if (fh) { readPath = dest; break; }
    await sleep(10);
  }
  if (!fh) throw new Error('下载文件始终未出现（可能下载启动失败）');

  try {
    while (sent < totalSize) {
      if (res.destroyed || res.writableEnded) break;

      let sizeNow = 0;
      try { sizeNow = (await fh.stat()).size; } catch { sizeNow = 0; }

      if (sizeNow <= sent) {
        // 只有当 .part 已经消失时，才说明下载收尾并改名了，此时才切到最终文件。
        // 注意：.part 暂时没有新数据（sizeNow 未增长）不等于它消失了，
        // 不能据此就切换，否则会在下载中途误判并中断回传。
        const partGone = !(await fileExists(partPath));
        if (partGone && readPath !== dest) {
          await fh.close().catch(() => {});
          fh = null;
          for (let i = 0; i < 500 && !fh; i++) {
            fh = await fsp.open(dest, 'r').catch(() => null);
            if (fh) { readPath = dest; break; }
            await sleep(10);
          }
          if (fh) continue;
          // 最终文件也打不开，只能结束
          break;
        }
        if (partGone && readPath === dest) break; // 已切到 dest 且读完
        await sleep(pollMs);
        continue;
      }

      const want = Math.min(CHUNK, totalSize - sent, sizeNow - sent);
      const buf = Buffer.allocUnsafe(want);
      await fh.read(buf, 0, want, sent);
      const ok = res.write(buf);
      if (!ok) await new Promise((r) => res.once('drain', r));
      sent += want;
    }
  } finally {
    if (fh) await fh.close().catch(() => {});
  }

  // 等下载真正结束（确保 .part 已改名为 dest，供后续缓存命中）
  await dlDone;
  res.end();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fileExists(p) {
  try { await fsp.stat(p); return true; } catch { return false; }
}
async function streamFile(res, filePath, size, req) {
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      const length = Math.max(0, end - start + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': length,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      });
      const stream = (await fsp.open(filePath)).createReadStream({ start, end });
      await new Promise((resolve, reject) => {
        stream.on('error', reject);
        res.on('close', resolve);
        res.on('finish', resolve);
        stream.pipe(res);
      });
      return;
    }
  }
  res.writeHead(200, {
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
  });
  const stream = (await fsp.open(filePath)).createReadStream();
  await new Promise((resolve, reject) => {
    stream.on('error', reject);
    res.on('close', resolve);
    res.on('finish', resolve);
    stream.pipe(res);
  });
}

/** 兜底：直接转发到目标，不用分片 */
async function pipeDirect(targetUrl, req, res, stats, logger) {
  const u = new URL(targetUrl);
  const client = u.protocol === 'https:' ? https : http;
  const upstream = client.request(targetUrl, {
    method: req.method,
    headers: {
      'User-Agent': req.headers['user-agent'] || DEFAULT_UA,
      'Accept-Encoding': 'identity',
    },
  }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 200, {
      'Content-Type': upRes.headers['content-type'] ?? 'application/octet-stream',
      'Content-Length': upRes.headers['content-length'],
      'Accept-Ranges': upRes.headers['accept-ranges'],
    });
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    stats.errors++;
    logger?.error?.(`直接转发失败: ${err.message}`);
    if (!res.headersSent) { res.writeHead(502); res.end(String(err.message)); }
  });
  req.pipe(upstream);
}
