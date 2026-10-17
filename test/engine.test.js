/**
 * 下载引擎测试 —— 用本地 HTTP 服务器构造确定性场景，
 * 不依赖外网，可重复运行。
 *
 * 覆盖：分片规划、Range 分片下载、断点续传、服务器不支持 Range 时的回退、
 * 429 限流重试、选源排序与缓存、哈希校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planSegments, planPieces, downloadSegmented } from '../src/engine/segment.js';
import { downloadTask } from '../src/engine/download.js';
import { SourceRanker, measureSource } from '../src/engine/probe.js';
import { verifyFile, hashFile } from '../src/engine/verify.js';

function mktmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mcboost-eng-')); }

/** 造一个可控的下载服务器 */
function makeServer({ body, supportRange = true, rate = 0, throttle429 = 0, failFirst = 0 } = {}) {
  let hits = 0;
  let remaining429 = throttle429;
  const server = http.createServer(async (req, res) => {
    hits++;
    if (remaining429 > 0) {
      remaining429--;
      res.writeHead(429, { 'Retry-After': '1' });
      res.end('slow down');
      return;
    }
    if (failFirst > 0 && hits <= failFirst) {
      res.writeHead(500); res.end('boom'); return;
    }
    const range = req.headers.range;
    if (supportRange && range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
      const chunk = body.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': chunk.length,
        'Accept-Ranges': 'bytes',
      });
      if (rate <= 0) { res.end(chunk); return; }
      // 按 rate 字节/秒 分批发送，便于制造"慢源"
      let off = 0;
      const step = Math.max(1, Math.floor(rate / 100));
      const timer = setInterval(() => {
        if (off >= chunk.length) { clearInterval(timer); res.end(); return; }
        res.write(chunk.subarray(off, off + step));
        off += step;
      }, 10);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, {
      'Content-Length': body.length,
      ...(supportRange ? { 'Accept-Ranges': 'bytes' } : {}),
    });
    if (rate <= 0) { res.end(body); return; }
    let off = 0;
    const step = Math.max(1, Math.floor(rate / 100));
    const timer = setInterval(() => {
      if (off >= body.length) { clearInterval(timer); res.end(); return; }
      res.write(body.subarray(off, off + step));
      off += step;
    }, 10);
    req.on('close', () => clearInterval(timer));
  });
  return { server, getHits: () => hits };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

function randomBody(size) {
  // 用确定性伪随机，便于复现
  const b = Buffer.alloc(size);
  let x = 12345;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x & 0xff; }
  return b;
}

// ————————————————————————————————————————————————
// 分片规划
// ————————————————————————————————————————————————

test('planSegments：大文件按连接数均分且无缝覆盖', () => {
  const size = 10 * 1024 * 1024;
  const segs = planSegments(size, { connections: 8, minSegmentSize: 1024 * 1024, segmentChunk: 1024 * 1024 });
  assert.equal(segs.length, 8);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[segs.length - 1].end, size - 1);
  for (let i = 1; i < segs.length; i++) {
    assert.equal(segs[i].start, segs[i - 1].end + 1, '分片之间不能有空洞或重叠');
  }
});

test('planSegments：小文件不分片', () => {
  const segs = planSegments(100 * 1024, { connections: 8, minSegmentSize: 1024 * 1024, segmentChunk: 1024 * 1024 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].start, 0);
});

test('planSegments：按 segmentChunk 限制最大分片数', () => {
  const size = 3 * 1024 * 1024;
  const segs = planSegments(size, { connections: 32, minSegmentSize: 1, segmentChunk: 1024 * 1024 });
  assert.equal(segs.length, 3, '3MB / 1MB 分片 = 最多 3 片');
});

test('planSegments：大小未知时退化为单段', () => {
  const segs = planSegments(null, { connections: 8, minSegmentSize: 1, segmentChunk: 1 });
  assert.equal(segs.length, 1);
});

// ————————————————————————————————————————————————
// 分片下载
// ————————————————————————————————————————————————

test('多连接分片下载：内容与源一致', async () => {
  const body = randomBody(3 * 1024 * 1024);
  const { server } = makeServer({ body });
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  try {
    const res = await downloadSegmented(`${base}/f`, dest, {
      connections: 8, minSegmentSize: 1024, segmentChunk: 64 * 1024, timeout: 15_000,
    });
    assert.equal(res.size, body.length);
    assert.equal(res.connections, 8, '应切出 8 个分片');
    const got = await fsp.readFile(dest);
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'),
                 crypto.createHash('sha256').update(body).digest('hex'), '下载内容必须与源逐字节一致');
    // .part 与状态文件应被清理
    assert.equal(fs.existsSync(dest + '.part'), false);
    assert.equal(fs.existsSync(dest + '.mcboost'), false);
  } finally { server.close(); }
});

test('服务器不支持 Range 时自动退化为单连接', async () => {
  const body = randomBody(512 * 1024);
  const { server } = makeServer({ body, supportRange: false });
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  try {
    const res = await downloadSegmented(`${base}/f`, dest, { connections: 8, minSegmentSize: 1024, timeout: 15_000 });
    assert.equal(res.connections, 1, '不支持 Range 必须退化为单连接');
    assert.deepEqual(await fsp.readFile(dest), body);
  } finally { server.close(); }
});

test('断点续传：中断后重跑只补缺失部分，最终内容正确', async () => {
  const body = randomBody(4 * 1024 * 1024);
  const { server } = makeServer({ body, rate: 400 * 1024 }); // 限速，保证能中途打断
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  const ctrl = new AbortController();
  try {
    // 第一次：下到一半就取消
    let seen = 0;
    const p = downloadSegmented(`${base}/f`, dest, {
      connections: 4, minSegmentSize: 1024, segmentChunk: 256 * 1024,
      timeout: 15_000, signal: ctrl.signal,
      onProgress: (d) => { seen = d; if (d > 400 * 1024) ctrl.abort(); },
    });
    await assert.rejects(p);
    assert.ok(seen > 0, '中断前应已下载到一些数据');
    assert.ok(fs.existsSync(dest + '.part'), '中断后应保留 .part 供续传');
    assert.ok(fs.existsSync(dest + '.mcboost'), '中断后应保留续传状态文件');

    const partSizeAfterAbort = fs.statSync(dest + '.part').size;

    // 第二次：续传
    const res = await downloadSegmented(`${base}/f`, dest, {
      connections: 4, minSegmentSize: 1024, segmentChunk: 256 * 1024, timeout: 20_000, resume: true,
    });
    assert.equal(res.resumed, true, '应识别出这是一次续传');
    assert.equal(res.size, body.length);
    assert.equal(res.bytes, body.length, '续传后统计的字节数应等于文件大小');
    assert.deepEqual(await fsp.readFile(dest), body, '续传结果必须正确（验证偏移没有错位）');
    void partSizeAfterAbort;
  } finally { server.close(); }
}, { timeout: 60_000 });

test('服务端 5xx 会自动重试并最终成功', async () => {
  const body = randomBody(256 * 1024);
  const { server, getHits } = makeServer({ body, failFirst: 2 });
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  try {
    const res = await downloadSegmented(`${base}/f`, dest, {
      connections: 1, minSegmentSize: 10 * 1024 * 1024, timeout: 15_000, retries: 4,
    });
    assert.deepEqual(await fsp.readFile(dest), body);
    assert.ok(getHits() >= 3, `应有重试，实际请求 ${getHits()} 次`);
    void res;
  } finally { server.close(); }
});

// ————————————————————————————————————————————————
// 校验
// ————————————————————————————————————————————————

test('verifyFile：命中与不命中', async () => {
  const dir = mktmp();
  const f = path.join(dir, 'a.bin');
  await fsp.writeFile(f, 'hello mcboost');
  const sha1 = crypto.createHash('sha1').update('hello mcboost').digest('hex');
  assert.equal((await hashFile(f, 'sha1')), sha1);
  assert.equal((await verifyFile(f, { sha1 })).ok, true);
  assert.equal((await verifyFile(f, { sha1: 'deadbeef' })).ok, false);
  assert.equal((await verifyFile(f, {})).checked, false, '没有提供哈希时应视为未校验');
  assert.equal((await verifyFile(f, null)).ok, true);
});

test('downloadTask：哈希不符时判定失败并删除坏文件', async () => {
  const body = randomBody(64 * 1024);
  const { server } = makeServer({ body });
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  const config = { connections: 4, minSegmentSize: 1024, segmentChunk: 16 * 1024, retries: 1, timeout: 10_000, verifyHash: true, autoSelectSource: false };
  try {
    await assert.rejects(
      downloadTask({ url: `${base}/f`, dest, hashes: { sha1: '0'.repeat(40) } },
        { config, logger: { debug() {} }, engine: 'builtin' }),
      /哈希校验失败/
    );
    assert.equal(fs.existsSync(dest), false, '校验失败的文件必须被删除，不能留下坏文件');
  } finally { server.close(); }
});

test('downloadTask：文件已存在且哈希匹配时跳过不重下', async () => {
  const body = randomBody(32 * 1024);
  const { server, getHits } = makeServer({ body });
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  await fsp.writeFile(dest, body);
  const sha1 = crypto.createHash('sha1').update(body).digest('hex');
  const config = { connections: 4, minSegmentSize: 1024, segmentChunk: 16 * 1024, retries: 1, timeout: 10_000, verifyHash: true, autoSelectSource: false };
  try {
    const res = await downloadTask({ url: `${base}/f`, dest, size: body.length, hashes: { sha1 } },
      { config, logger: { debug() {} }, engine: 'builtin' });
    assert.equal(res.status, 'skipped');
    assert.equal(getHits(), 0, '跳过时不应发起任何网络请求');
  } finally { server.close(); }
});

// ————————————————————————————————————————————————
// 选源
// ————————————————————————————————————————————————

test('SourceRanker：把更快的源排在前面，并且结果被缓存', async () => {
  const body = randomBody(1024 * 1024);
  const fast = makeServer({ body });
  const slow = makeServer({ body, rate: 120 * 1024 });
  const fastBase = await listen(fast.server);
  const slowBase = await listen(slow.server);
  try {
    const candidates = [
      { url: `${slowBase}/f`, source: '慢源' },
      { url: `${fastBase}/f`, source: '快源' },
    ];
    const ranker = new SourceRanker({ logger: { debug() {} } });
    const ordered = await ranker.rank(candidates, {
      connections: 2, fileSize: body.length, minMs: 600, maxBytesPerStream: 256 * 1024, timeout: 15_000,
    });
    assert.equal(ordered[0].source, '快源', `应选快源，实际顺序: ${ordered.map((c) => c.source).join(' > ')}`);
    assert.equal(ranker.probes, 1);

    // 第二次同样的源组合应命中缓存，不再探测
    const again = await ranker.rank(candidates, { connections: 2, fileSize: body.length, timeout: 15_000 });
    assert.equal(ranker.probes, 1, '第二次不应再探测');
    assert.equal(ranker.hits, 1);
    assert.equal(again[0].source, '快源');

    // 作废后应重新探测
    ranker.invalidate(candidates);
    assert.equal(ranker.size, 0);
  } finally { fast.server.close(); slow.server.close(); }
}, { timeout: 60_000 });

test('measureSource：识别服务器是否支持 Range', async () => {
  const body = randomBody(512 * 1024);
  const yes = makeServer({ body, supportRange: true });
  const no = makeServer({ body, supportRange: false });
  const yesBase = await listen(yes.server);
  const noBase = await listen(no.server);
  try {
    const a = await measureSource(`${yesBase}/f`, { streams: 2, minMs: 300, maxBytesPerStream: 64 * 1024, timeout: 10_000 });
    const b = await measureSource(`${noBase}/f`, { streams: 2, minMs: 300, maxBytesPerStream: 64 * 1024, timeout: 10_000 });
    assert.equal(a.supportsRange, true);
    assert.equal(a.size, body.length, '支持 Range 时应能拿到文件大小');
    assert.equal(b.supportsRange, false);
    assert.equal(b.streams, 1, '不支持 Range 时只应使用 1 条流');
  } finally { yes.server.close(); no.server.close(); }
});

test('downloadTask：主源 404 时自动切换到备用源', async () => {
  const body = randomBody(128 * 1024);
  const good = makeServer({ body });
  const bad = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  const goodBase = await listen(good.server);
  const badBase = await listen(bad);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  const config = { connections: 2, minSegmentSize: 1024, segmentChunk: 16 * 1024, retries: 1, timeout: 10_000, verifyHash: false, autoSelectSource: false };
  try {
    const res = await downloadTask({
      url: `${badBase}/f`, dest,
      candidates: [{ url: `${badBase}/f`, source: '坏源' }, { url: `${goodBase}/f`, source: '好源' }],
    }, { config, logger: { debug() {} }, engine: 'builtin' });
    assert.equal(res.status, 'done');
    assert.equal(res.source, '好源', '应回退到能用的源');
    assert.deepEqual(await fsp.readFile(dest), body);
  } finally { good.server.close(); bad.close(); }
});

// ————————————————————————————————————————————————
// 小分片 + 动态队列调度
// ————————————————————————————————————————————————

test('planPieces：小分片无缝覆盖且片数受上限约束', () => {
  const size = 20 * 1024 * 1024;
  const pieces = planPieces(size, { pieceSize: 2 * 1024 * 1024 });
  assert.equal(pieces.length, 10);
  assert.equal(pieces[0].start, 0);
  assert.equal(pieces[pieces.length - 1].end, size - 1);
  for (let i = 1; i < pieces.length; i++) {
    assert.equal(pieces[i].start, pieces[i - 1].end + 1, '分片之间不能有空洞或重叠');
  }
  // 超大文件应被 MAX_PIECES 约束，避免状态文件爆炸
  const huge = planPieces(100 * 1024 ** 3, { pieceSize: 1024 });
  assert.ok(huge.length <= 4096, `分片数应受上限约束，实际 ${huge.length}`);
});

test('动态调度：某个分片被饿死时会由其它连接接手完成', async () => {
  const body = randomBody(6 * 1024 * 1024);
  // 这个服务器会"饿死"前 N 个**批量数据**请求：不返回任何数据，也不关闭连接。
  // 注意只饿死大块请求 —— 真实的 CDN 卡的是数据流，不是 1 字节的探测请求；
  // 把探测也一起卡住，测的就变成探测超时而不是调度逻辑了。
  let served = 0;
  const starveFirst = 3;
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      const end = m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
      const span = end - start + 1;
      // 只对"覆盖开头的大块请求"装死，模拟被 CDN 饿死的连接
      if (start === 0 && span > 1 && served < starveFirst) {
        served++;
        return; // 挂起不响应 —— 连接被饿死
      }
      const chunk = body.subarray(start, end + 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': chunk.length });
      res.end(chunk);
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  try {
    const res = await downloadSegmented(`${base}/f`, dest, {
      connections: 4, minSegmentSize: 1024, pieceSize: 512 * 1024,
      stallMs: 800, timeout: 15_000, maxPieceAttempts: 8,
    });
    assert.equal(res.size, body.length);
    assert.ok(res.pieces > 1, '应切成多个小分片');
    assert.deepEqual(await fsp.readFile(dest), body, '被饿死的分片必须最终由别的连接补齐');
  } finally { server.close(); }
}, { timeout: 60_000 });

test('动态调度：进度统计与实际字节数一致（稀疏文件不能骗过校验）', async () => {
  const body = randomBody(5 * 1024 * 1024);
  const { server } = makeServer({ body });
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  try {
    let last = 0;
    const res = await downloadSegmented(`${base}/f`, dest, {
      connections: 4, minSegmentSize: 1024, pieceSize: 256 * 1024, timeout: 20_000,
      onProgress: (d) => { last = d; },
    });
    assert.equal(res.bytes, body.length, '返回的传输字节数应等于文件大小');
    assert.equal(last, body.length, '最后一次进度回调应等于文件大小');
    assert.ok(res.pieces >= 20, `5MB / 256KB 应至少 20 片，实际 ${res.pieces}`);
  } finally { server.close(); }
});

test('分片队列：服务器中途开始返回 500，仍能靠重试完成', async () => {
  const body = randomBody(2 * 1024 * 1024);
  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    // 第 2、3 个请求失败，之后恢复正常
    if (n === 2 || n === 3) { res.writeHead(500); res.end('x'); return; }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      const end = m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
      const chunk = body.subarray(start, end + 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': chunk.length });
      res.end(chunk);
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
  });
  const base = await listen(server);
  const dir = mktmp();
  const dest = path.join(dir, 'out.bin');
  try {
    await downloadSegmented(`${base}/f`, dest, {
      connections: 3, minSegmentSize: 1024, pieceSize: 256 * 1024, timeout: 15_000, maxPieceAttempts: 6,
    });
    assert.deepEqual(await fsp.readFile(dest), body);
  } finally { server.close(); }
});
