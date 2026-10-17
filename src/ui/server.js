/**
 * mcboost 网页版 —— 零依赖 HTTP 服务 + SSE 实时进度。
 *
 * 提供与 CLI 完全相同的下载能力，但可以从浏览器操作、实时看进度和选源情况。
 */
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { loadConfig, saveConfig, defaultConfig, testMirrors, BUILTIN_MIRRORS } from '../mirrors.js';
import { runPack, planPack, pickEngine, createContext } from '../pipeline.js';
import { detectAria2 } from '../engine/aria.js';
import { measureSource } from '../engine/probe.js';
import { candidatesFor } from '../mirrors.js';
import { fmtBytes } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 内存中的任务对象 */
class Job {
  constructor({ id, input, outDir, options }) {
    this.id = id;
    this.input = input;
    this.outDir = outDir;
    this.options = options;
    this.state = 'pending'; // pending | planning | running | done | failed | cancelled
    this.createdAt = Date.now();
    this.startedAt = null;
    this.finishedAt = null;
    this.meta = null;
    this.instanceDir = null;
    this.taskCount = 0;
    this.totalBytes = 0;
    this.tasks = new Map();
    this.logs = [];
    this.summary = null;
    this.error = null;
    this.buffer = [];       // 供后订阅者回放的事件
    this.subscribers = new Set();
    this.controller = new AbortController();
  }

  emit(ev) {
    const enriched = { jobId: this.id, ts: Date.now(), ...ev };
    this.buffer.push(enriched);
    if (this.buffer.length > 500) this.buffer.splice(0, this.buffer.length - 500);
    const payload = `data: ${JSON.stringify(enriched)}\n\n`;
    for (const res of this.subscribers) {
      try { res.write(payload); } catch { /* 客户端断开 */ }
    }
  }

  snapshot() {
    return {
      id: this.id,
      input: this.input,
      outDir: this.outDir,
      state: this.state,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      meta: this.meta,
      instanceDir: this.instanceDir,
      taskCount: this.taskCount,
      totalBytes: this.totalBytes,
      summary: this.summary,
      error: this.error,
      tasks: [...this.tasks.entries()].map(([id, t]) => ({ id, ...t })),
      logs: this.logs.slice(-200),
      serverTime: Date.now(),
    };
  }

  cancel() {
    this.controller.abort();
  }
}

const jobs = new Map();

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 1024 * 512) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

/** 把 Logger 接口适配成"同时写日志缓冲 + 在终端打印" */
function jobLogger(job, baseLogger) {
  const push = (level, message) => {
    job.logs.push({ level, message, ts: Date.now() });
    if (job.logs.length > 500) job.logs.shift();
    job.emit({ type: 'log', level, message });
  };
  return {
    info: (m) => push('info', m),
    warn: (m) => push('warn', m),
    error: (m) => push('error', m),
    debug: (m) => { if (baseLogger?.verbose) push('debug', m); },
  };
}

async function startJob({ input, outDir, options }, baseLogger) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = new Job({ id, input, outDir, options });
  jobs.set(id, job);

  // 异步跑，不阻塞 HTTP 响应
  (async () => {
    try {
      const config = { ...(await loadConfig()), ...pickOptions(options) };
      job.state = 'planning';
      job.emit({ type: 'state', state: 'planning' });

      const logger = jobLogger(job, baseLogger);
      job.startedAt = Date.now();
      job.state = 'running';
      job.emit({ type: 'state', state: 'running' });

      const result = await runPack(input, {
        config,
        logger,
        signal: job.controller.signal,
        outDir,
        instanceName: options?.instanceName,
        side: options?.side ?? 'client',
        dryRun: !!options?.dryRun,
        concurrency: config.concurrency,
        connections: config.connections,
        showProgress: false,
        include: options?.include,
        onEvent: (ev) => {
          if (ev.type === 'plan') {
            job.meta = ev.meta;
            job.instanceDir = ev.instanceDir;
            job.taskCount = ev.taskCount;
            job.totalBytes = ev.totalBytes;
          }
          if (ev.type === 'task:start') {
            job.tasks.set(ev.id, { label: ev.label, size: ev.size, downloaded: 0, status: 'downloading' });
          }
          if (ev.type === 'task:progress') {
            const t = job.tasks.get(ev.id);
            if (t) { t.downloaded = ev.downloaded; t.total = ev.total; }
          }
          if (ev.type === 'task:done') {
            const t = job.tasks.get(ev.id);
            if (t) { t.status = ev.status; t.speed = ev.speed; t.source = ev.source; t.engine = ev.engine; }
          }
          if (ev.type === 'task:failed') {
            const t = job.tasks.get(ev.id);
            if (t) { t.status = 'failed'; t.error = ev.error; }
          }
          job.emit(ev);
        },
      });

      job.summary = result.stats ?? null;
      if (result.dryRun) { job.state = 'done'; job.summary = { dryRun: true }; }
      else job.state = result.failures?.length ? 'done' : 'done';
      job.finishedAt = Date.now();
      job.emit({ type: 'finished', state: job.state, summary: job.summary });
    } catch (err) {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = err.message;
      job.finishedAt = Date.now();
      job.emit({ type: 'finished', state: job.state, error: err.message });
    }
  })();

  return job;
}

function pickOptions(options = {}) {
  const out = {};
  if (options.concurrency != null) out.concurrency = Math.max(1, Math.min(64, Number(options.concurrency)));
  if (options.connections != null) out.connections = Math.max(1, Math.min(64, Number(options.connections)));
  if (options.useMirrors === false) out.useMirrors = false;
  if (options.engine) out.engine = options.engine;
  if (options.autoSelectSource === false) out.autoSelectSource = false;
  return out;
}

async function buildDoctor(config) {
  const aria = await detectAria2(config.aria2Path);
  const { engine } = await pickEngine(config, { debug: () => {} });
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: os.cpus().length,
    homedir: os.homedir(),
    aria2: aria ? { available: true, version: aria.version } : { available: false },
    engine,
    configPath: (await import('../mirrors.js')).defaultConfigPath(),
    defaults: {
      concurrency: config.concurrency,
      connections: config.connections,
      useMirrors: config.useMirrors !== false,
      autoSelectSource: config.autoSelectSource !== false,
      curseforgeApiKey: !!config.curseforgeApiKey,
    },
  };
}

function routes(server, { config: initialConfig, logger }) {
  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;
    try {
      // —— 静态页面 ——
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = await fsp.readFile(path.join(__dirname, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      // —— 环境信息 ——
      if (req.method === 'GET' && p === '/api/doctor') {
        const config = await loadConfig();
        return json(res, 200, await buildDoctor(config));
      }

      // —— 配置 ——
      if (req.method === 'GET' && p === '/api/config') {
        const config = await loadConfig();
        // 不回传 API key 明文
        return json(res, 200, { ...config, curseforgeApiKey: config.curseforgeApiKey ? '已配置' : '' });
      }
      if (req.method === 'POST' && p === '/api/config') {
        const body = await readBody(req);
        const config = await loadConfig();
        for (const [k, v] of Object.entries(body ?? {})) {
          if (!(k in defaultConfig())) continue;
          if (k === 'curseforgeApiKey' && v === '已配置') continue;
          config[k] = v;
        }
        await saveConfig(config);
        return json(res, 200, { ok: true });
      }

      // —— 镜像 ——
      if (req.method === 'GET' && p === '/api/mirrors') {
        const config = await loadConfig();
        const disabled = new Set(config.disabledMirrors ?? []);
        return json(res, 200, {
          useMirrors: config.useMirrors !== false,
          builtin: BUILTIN_MIRRORS.map((m) => ({
            id: m.id, name: m.name, kind: m.kind, enabled: m.enabled !== false && !disabled.has(m.id),
            rules: (m.rules ?? []).map((r) => `${r.from} → ${r.to}`),
          })),
          custom: (config.customMirrors ?? []).map((m) => ({ id: m.id, name: m.name, kind: m.kind, rules: m.rules })),
        });
      }
      if (req.method === 'POST' && p === '/api/mirrors/test') {
        const config = await loadConfig();
        const reports = await testMirrors(config);
        return json(res, 200, { reports });
      }

      // —— 解析预览 ——
      if (req.method === 'POST' && p === '/api/plan') {
        const body = await readBody(req);
        if (!body?.input) return json(res, 400, { error: '缺少 input' });
        const config = { ...(await loadConfig()), ...pickOptions(body.options) };
        const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        const plan = await planPack(body.input, { config, logger: quiet, side: body.options?.side ?? 'client', instanceDir: '' });
        const total = plan.tasks.reduce((a, t) => a + (t.size ?? 0), 0);
        return json(res, 200, {
          packType: plan.type,
          meta: plan.meta,
          taskCount: plan.tasks.length,
          totalBytes: total,
          unresolved: plan.unresolved?.length ?? 0,
          warnings: plan.warnings ?? [],
          sample: plan.tasks.slice(0, 30).map((t) => ({
            label: t.label ?? path.basename(t.dest),
            size: t.size ?? null,
            host: (() => { try { return new URL(t.url).host; } catch { return '?'; } })(),
            candidates: t.candidates?.length ?? 1,
          })),
        });
      }

      // —— 任务 ——
      if (req.method === 'GET' && p === '/api/jobs') {
        return json(res, 200, { jobs: [...jobs.values()].map((j) => j.snapshot()) });
      }
      if (req.method === 'POST' && p === '/api/jobs') {
        const body = await readBody(req);
        if (!body?.input) return json(res, 400, { error: '缺少 input' });
        const outDir = body.outDir ? path.resolve(body.outDir) : path.join(os.homedir(), 'mcboost-downloads');
        const job = await startJob({ input: body.input, outDir, options: body.options ?? {} }, logger);
        return json(res, 200, { jobId: job.id, job: job.snapshot() });
      }

      const jobMatch = /^\/api\/jobs\/([a-f0-9]+)(\/cancel|\/events)?$/.exec(p);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return json(res, 404, { error: '任务不存在' });

        if (jobMatch[2] === '/cancel' && req.method === 'POST') {
          job.cancel();
          job.emit({ type: 'log', level: 'warn', message: '用户取消任务' });
          return json(res, 200, { ok: true });
        }
        if (jobMatch[2] === '/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(`retry: 2000\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'snapshot', job: job.snapshot() })}\n\n`);
          for (const ev of job.buffer) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          job.subscribers.add(res);
          const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15_000);
          req.on('close', () => { clearInterval(ping); job.subscribers.delete(res); });
          return;
        }
        if (req.method === 'GET') return json(res, 200, job.snapshot());
      }

      // —— 临时测速（网页上直接试某个 URL） ——
      if (req.method === 'POST' && p === '/api/probe') {
        const body = await readBody(req);
        if (!body?.url) return json(res, 400, { error: '缺少 url' });
        const config = await loadConfig();
        const cands = candidatesFor(body.url, config);
        const results = await Promise.all(cands.map(async (c) => {
          const r = await measureSource(c.url, {
            streams: body.streams ?? config.connections,
            minMs: 2000,
            maxBytesPerStream: config.probeBytes,
            timeout: 30_000,
          });
          return {
            source: c.source, url: c.url, ok: r.ok,
            bps: r.bps, bpsText: fmtBytes(r.bps) + '/s',
            streams: r.streams, ms: r.ms, bytes: r.bytes, error: r.error ?? null,
          };
        }));
        return json(res, 200, { results: results.sort((a, b) => (b.bps || 0) - (a.bps || 0)) });
      }

      json(res, 404, { error: 'Not Found' });
    } catch (err) {
      logger?.error?.(`HTTP 处理出错: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: err.message });
      else { try { res.end(); } catch { /* ignore */ } }
    }
  });
}

export async function startWebServer({ port = 8787, host = '0.0.0.0', config, logger }) {
  const server = http.createServer();
  server.keepAliveTimeout = 65_000;
  routes(server, { config, logger });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const shown = host === '0.0.0.0' ? (localIPv4()[0] ?? '127.0.0.1') : host;
  logger?.info('');
  logger?.info(`\x1b[1m mcboost 网页版已启动 \x1b[0m`);
  logger?.info(`   本机访问 : http://127.0.0.1:${port}`);
  if (shown !== '127.0.0.1') logger?.info(`   局域网   : http://${shown}:${port}`);
  logger?.info(`   输出目录 : 在页面上指定，默认为 ~/mcboost-downloads`);
  if (host === '0.0.0.0') {
    logger?.info('');
    logger?.info('   \x1b[33m注意\x1b[0m: 已监听所有网卡，同网段任何设备都能访问本页面并写入文件。');
    logger?.info('        不可信网络请改用 --host 127.0.0.1。');
  }
  logger?.info('');
  logger?.info('   按 Ctrl+C 退出');
  return server;
}

function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
