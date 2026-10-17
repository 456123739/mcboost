#!/usr/bin/env node
/**
 * mcboost —— Minecraft 整合包下载加速器 CLI
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { loadConfig, saveConfig, defaultConfig, defaultConfigPath, testMirrors, BUILTIN_MIRRORS, candidatesFor } from '../src/mirrors.js';
import { runPack, planPack, pickEngine } from '../src/pipeline.js';
import { detectAria2 } from '../src/engine/aria.js';
import { downloadSegmented } from '../src/engine/segment.js';
import { measure } from '../src/engine/probe.js';
import { request } from '../src/net/http.js';
import { Logger, fmtBytes, fmtSpeed, fmtDuration, ensureDir, pool, safeFileName } from '../src/util.js';
import { resolveModrinthPack } from '../src/packs/modrinth.js';

const VERSION = '0.1.0';

const HELP = `
\x1b[1mmcboost\x1b[0m v${VERSION} — Minecraft 整合包下载加速器

\x1b[1m用法\x1b[0m
  mcboost pack <整合包.zip|.mrpack|URL> [选项]   下载并安装整合包（主命令）
  mcboost modrinth <项目slug> [选项]             直接从 Modrinth 下载整合包
  mcboost get <URL...> [选项]                    加速下载任意文件（多连接分片）
  mcboost bench <URL> [选项]                     实测单连接 vs 多连接提速效果
  mcboost sources <URL>                          诊断：列出所有候选源并实测各自吞吐
  mcboost info <整合包>                          只解析不下载，查看文件清单
  mcboost mirrors test                           实测各镜像源是否可用
  mcboost config <get|set|list|path> [k] [v]     查看/修改配置
  mcboost web [--port 8787]                      启动网页版界面
  mcboost proxy [--port 8788]                    启动本地加速代理（供 PCL2/PCL CE 改下载源使用）
  mcboost search <关键词>                        搜索整合包（Modrinth / CurseForge）
  mcboost doctor                                 检查运行环境

\x1b[1m常用选项\x1b[0m
  -o, --out <目录>        输出目录（整合包会在此目录下建同名文件夹）
  -n, --name <名字>       实例文件夹名
  -j, --concurrency <N>   同时下载的文件数（默认 6）
  -x, --connections <N>   单个文件的连接/分片数（默认 8）
  -e, --engine <引擎>     auto | aria2 | builtin（默认 auto）
      --side <端>         client | server（默认 client）
      --include <正则>    只下载匹配的文件名
      --no-mirror         不使用任何镜像，直连官方源
      --dry-run           只显示计划，不实际下载
      --no-progress       不显示进度条
  -v, --verbose           输出调试信息
  -h, --help              显示帮助
  -V, --version           显示版本
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const bools = new Set(['dry-run', 'no-mirror', 'verbose', 'help', 'version', 'no-progress', 'json', 'force', 'quiet']);
  const alias = { o: 'out', n: 'name', j: 'concurrency', x: 'connections', e: 'engine', v: 'verbose', h: 'help', V: 'version' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const key = alias[k] ?? k;
      if (bools.has(key)) { flags[key] = inline === undefined ? true : inline !== 'false'; }
      else if (inline !== undefined) flags[key] = inline;
      else { flags[key] = argv[++i]; }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = alias[a.slice(1)] ?? a.slice(1);
      if (bools.has(key)) flags[key] = true;
      else flags[key] = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function makeLogger(flags) {
  return new Logger({ verbose: !!flags.verbose, quiet: !!flags.quiet });
}

function buildConfig(base, flags) {
  const cfg = { ...base };
  if (flags.concurrency) cfg.concurrency = clampInt(flags.concurrency, 1, 64, 'concurrency');
  if (flags.connections) cfg.connections = clampInt(flags.connections, 1, 64, 'connections');
  if (flags.engine) {
    if (!['auto', 'aria2', 'builtin'].includes(flags.engine)) throw new Error(`--engine 只能是 auto/aria2/builtin`);
    cfg.engine = flags.engine;
  }
  if (flags['no-mirror']) cfg.useMirrors = false;
  return cfg;
}

function clampInt(v, min, max, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字`);
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);

  if (flags.version || positional[0] === 'version') { console.log(VERSION); return 0; }
  if (flags.help || positional.length === 0 || positional[0] === 'help') { console.log(HELP); return 0; }

  const logger = makeLogger(flags);
  const cmd = positional[0];
  const rest = positional.slice(1);
  const baseConfig = await loadConfig();
  const config = buildConfig(baseConfig, flags);

  switch (cmd) {
    case 'pack': return cmdPack(rest, flags, config, logger);
    case 'modrinth': return cmdModrinth(rest, flags, config, logger);
    case 'get': return cmdGet(rest, flags, config, logger);
    case 'bench': return cmdBench(rest, flags, config, logger);
    case 'sources': return cmdSources(rest, flags, config, logger);
    case 'info': return cmdInfo(rest, flags, config, logger);
    case 'mirrors': return cmdMirrors(rest, flags, config, logger);
    case 'config': return cmdConfig(rest, flags, config, logger);
    case 'web': return cmdWeb(rest, flags, config, logger);
    case 'proxy': return cmdProxy(rest, flags, config, logger);
    case 'search': return cmdSearch(rest, flags, config, logger);
    case 'doctor': return cmdDoctor(flags, config, logger);
    default:
      logger.error(`未知命令: ${cmd}`);
      console.log(HELP);
      return 1;
  }
}

async function cmdPack(rest, flags, config, logger) {
  const input = rest[0];
  if (!input) throw new Error('请提供整合包路径、下载 URL 或 Modrinth 项目 slug');
  // 输入解析（本地文件 / URL / Modrinth slug）统一交给 pipeline
  const res = await runPack(input, {
    config,
    logger,
    outDir: flags.out ? path.resolve(flags.out) : process.cwd(),
    instanceName: flags.name,
    side: flags.side ?? 'client',
    dryRun: !!flags['dry-run'],
    concurrency: config.concurrency,
    connections: config.connections,
    showProgress: !flags['no-progress'],
    include: flags.include,
  });
  return res.stats?.failed ? 2 : 0;
}

async function cmdModrinth(rest, flags, config, logger) {
  const slug = rest[0];
  if (!slug) throw new Error('请提供 Modrinth 项目 slug，例如：mcboost modrinth fabulously-optimized');
  logger.info(`查询 Modrinth: ${slug} …`);
  const pack = await resolveModrinthPack(slug, flags.version ?? flags['pack-version']);
  logger.info(`找到: \x1b[1m${pack.name}\x1b[0m ${pack.versionNumber}  (MC ${pack.gameVersions.join('/')}, ${pack.loaders.join('/')})`);
  const outDir = flags.out ? path.resolve(flags.out) : process.cwd();
  await ensureDir(outDir);
  const tmp = path.join(outDir, `.mcboost-cache`);
  await ensureDir(tmp);
  const dest = path.join(tmp, pack.fileName);

  logger.info(`下载整合包: ${pack.fileName} (${fmtBytes(pack.size ?? 0)})`);
  const { engine } = await pickEngine(config, logger);
  if (engine === 'aria2') {
    const { ariaDownload } = await import('../src/engine/aria.js');
    await ariaDownload([pack.url], dest, {
      connections: config.connections, bin: config.aria2Path, signal: undefined,
      timeout: config.timeout, size: pack.size,
      onProgress: (d, t) => {
        if (process.stderr.isTTY) process.stderr.write(`\r  整合包本体 ${fmtBytes(d)}${t ? `/${fmtBytes(t)}` : ''}   `);
      },
    });
    process.stderr.write('\n');
  } else {
    await downloadSegmented(pack.url, dest, {
      connections: config.connections, minSegmentSize: config.minSegmentSize,
      size: pack.size, timeout: config.timeout,
      onProgress: (d, t) => { if (process.stderr.isTTY) process.stderr.write(`\r  整合包本体 ${fmtBytes(d)}${t ? `/${fmtBytes(t)}` : ''}   `); },
    });
    process.stderr.write('\n');
  }

  const res = await runPack(dest, {
    config, logger,
    outDir,
    instanceName: flags.name ?? pack.name,
    side: flags.side ?? 'client',
    dryRun: !!flags['dry-run'],
    showProgress: !flags['no-progress'],
    include: flags.include,
  });
  return res.stats?.failed ? 2 : 0;
}

async function cmdGet(rest, flags, config, logger) {
  if (!rest.length) throw new Error('请提供至少一个 URL');
  const outDir = path.resolve(flags.out ?? '.');
  await ensureDir(outDir);
  const { engine } = await pickEngine(config, logger);
  logger.info(`引擎: ${engine === 'aria2' ? 'aria2c' : '内置多连接分片'}  |  并发文件 ${config.concurrency} × 每文件 ${config.connections} 连接`);
  if (config.useMirrors) logger.info('镜像: 已启用（自动测速选源）');

  // 与整合包下载走完全相同的任务管线：测速选源 → 下载 → 失败换源
  const { downloadTask } = await import('../src/engine/download.js');
  const { createContext } = await import('../src/pipeline.js');
  const ctx = await createContext(config, { logger, engine, connections: config.connections });
  ctx.logger = flags.verbose ? logger : { ...logger, debug: () => {} };

  let failed = 0;
  await pool(rest, config.concurrency, async (url, i) => {
    let name;
    try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || `download-${i}`); }
    catch { name = `download-${i}`; }
    const dest = path.join(outDir, safeFileName(name));
    const t0 = Date.now();
    try {
      const res = await downloadTask({
        id: `get-${i}`, label: name, url, dest,
        candidates: candidatesFor(url, config),
      }, ctx);
      const el = ((Date.now() - t0) / 1000) || 0.001;
      logger.info(`✔ ${name}  ${fmtBytes(res.size)}  ${fmtDuration(el)}  ${fmtSpeed(res.size / el)}  源=${res.source}`);
    } catch (err) {
      failed++;
      logger.error(`${name}: ${err.message}`);
    }
  });
  if (ctx.ranker && (ctx.ranker.probes || ctx.ranker.hits)) {
    logger.info(`测速缓存: 实际探测 ${ctx.ranker.probes} 次，命中 ${ctx.ranker.hits} 次`);
  }
  return failed ? 2 : 0;
}

/**
 * mcboost sources <URL> —— 诊断命令：
 * 列出该 URL 的所有候选源（原始源 + 命中的镜像），并实测各自真实吞吐，
 * 告诉用户"为什么慢"以及"走哪条源最快"。
 */
async function cmdSources(rest, flags, config, logger) {
  const url = rest[0];
  if (!url) throw new Error('请提供 URL');
  const cands = candidatesFor(url, config);
  logger.info(`候选源共 ${cands.length} 个：\n`);
  for (const [i, c] of cands.entries()) {
    logger.info(`  [${i}] ${c.source}`);
    logger.info(`      ${c.url}`);
  }
  if (cands.length === 1) {
    logger.info('\n该 URL 没有命中任何镜像规则（属正常：Modrinth/CurseForge CDN 本身无国内镜像）。');
    logger.info('提速仍可通过多连接分片实现，见 mcboost bench。');
  }
  logger.info(`\n实测各源真实吞吐（每条流至少 ${(2000 / 1000).toFixed(0)} 秒，避开 TCP 慢启动）…`);
  const { measureSource } = await import('../src/engine/probe.js');
  const streams = config.connections;
  const rows = await Promise.all(cands.map(async (c) => {
    const r = await measureSource(c.url, {
      streams, minMs: 2000, maxBytesPerStream: config.probeBytes,
      timeout: 30_000,
    });
    return { c, r };
  }));
  logger.info('');
  for (const { c, r } of rows.sort((a, b) => (b.r.bps || 0) - (a.r.bps || 0))) {
    if (r.ok) {
      logger.info(`  \x1b[32m✓\x1b[0m ${fmtSpeed(r.bps).padStart(12)}  ${String(r.streams).padStart(2)} 流  ${String(r.ms).padStart(6)}ms  ${c.source}`);
    } else {
      logger.info(`  \x1b[31m✗\x1b[0m ${'不可用'.padStart(12)}            ${c.source}  (${r.error ?? 'HTTP ' + r.status})`);
    }
  }
  const best = rows.filter((x) => x.r.ok).sort((a, b) => b.r.bps - a.r.bps)[0];
  if (best) {
    const worst = rows.filter((x) => x.r.ok).sort((a, b) => a.r.bps - b.r.bps)[0];
    logger.info(`\n最快源: ${best.c.source}  ${fmtSpeed(best.r.bps)}  (${best.r.streams} 流)`);
    if (worst && worst !== best) {
      logger.info(`最慢源: ${worst.c.source}  ${fmtSpeed(worst.r.bps)}  —— 相差 ${(best.r.bps / Math.max(1, worst.r.bps)).toFixed(1)}×`);
    }
  } else {
    logger.warn('所有候选源当前都不可用。');
  }
  const limited = rows.find((x) => /429/.test(String(x.r.error ?? '')));
  if (limited) {
    logger.warn(
      `\n注意：${limited.c.source} 返回了 429（限流）。BMCLAPI 是公益镜像，` +
      `有速率限制，请勿高频请求；mcboost 已按"主机对"缓存选源结果以避免重复探测。`
    );
  }
  return 0;
}

async function cmdBench(rest, flags, config, logger) {
  const url = rest[0];
  if (!url) throw new Error('请提供要测速的 URL');
  const bytes = Number(flags.bytes ?? 6 * 1024 * 1024);
  const maxX = Number(flags.max ?? 16);

  logger.info(`测速目标: ${url}`);
  logger.info(`每种连接数下载 ${fmtBytes(bytes)}，取实测吞吐。\n`);

  const rows = [];
  for (let x = 1; x <= maxX; x = x === 1 ? 4 : x * 2) {
    if (x > maxX) break;
    const tmp = path.join(process.env.TMPDIR ?? '/tmp', `mcboost-bench-${x}-${Date.now()}.bin`);
    const t0 = Date.now();
    try {
      if (x === 1) {
        // 单连接：直接流式读取固定字节
        const t = Date.now();
        const res = await request(url, { timeout: 60_000, retries: 1 });
        let got = 0;
        const reader = res.body.getReader();
        while (got < bytes) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value?.length ?? 0;
        }
        try { await reader.cancel(); } catch { /* ignore */ }
        const el = (Date.now() - t) / 1000;
        rows.push({ x: 1, bps: got / el, bytes: got, elapsed: el, ttfb: 0 });
      } else {
        // 多连接：切 x 片并发拉，统计总吞吐
        const probe = await request(url, { headers: { Range: 'bytes=0-0' }, timeout: 30_000, retries: 1 });
        const cr = probe.headers.get('content-range');
        await probe.arrayBuffer().catch(() => {});
        if (!cr) { logger.warn('该服务器不支持 Range，无法测试多连接（这本身就是单连接慢的原因之一）'); break; }
        const size = Number(/\/(\d+)$/.exec(cr)[1]);
        const take = Math.min(bytes, size);
        const per = Math.ceil(take / x);
        const t = Date.now();
        const results = await Promise.all(new Array(x).fill(0).map(async (_, i) => {
          const start = i * per;
          if (start >= size) return 0;
          const end = Math.min(start + per - 1, size - 1);
          const r = await request(url, { headers: { Range: `bytes=${start}-${end}` }, timeout: 60_000, retries: 1 });
          let got = 0;
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            got += value?.length ?? 0;
          }
          return got;
        }));
        const got = results.reduce((a, b) => a + b, 0);
        const el = (Date.now() - t) / 1000;
        rows.push({ x, bps: got / el, bytes: got, elapsed: el });
      }
    } catch (err) {
      logger.warn(`${x} 连接: 失败 (${err.message})`);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
    const last = rows[rows.length - 1];
    if (last) logger.info(`  ${String(last.x).padStart(2)} 连接   ${fmtSpeed(last.bps).padStart(12)}   ${fmtBytes(last.bytes)} / ${last.elapsed.toFixed(2)}s`);
  }

  if (rows.length >= 2) {
    const base = rows[0].bps || 1;
    const best = rows.reduce((a, b) => (b.bps > a.bps ? b : a));
    logger.info('');
    logger.info(`单连接基准: ${fmtSpeed(base)}`);
    logger.info(`最优      : ${best.x} 连接 → ${fmtSpeed(best.bps)}（提速 ${(best.bps / base).toFixed(1)}×）`);
  }
  return 0;
}

async function cmdInfo(rest, flags, config, logger) {
  const input = rest[0];
  if (!input) throw new Error('请提供整合包路径或 URL');
  const plan = await planPack(input, { config, logger, side: flags.side ?? 'client', instanceDir: '' });
  const total = plan.tasks.reduce((a, t) => a + (t.size ?? 0), 0);
  logger.info('');
  logger.info(`类型     : ${plan.type}`);
  logger.info(`名称     : ${plan.meta.name} ${plan.meta.version}`);
  logger.info(`MC 版本  : ${plan.meta.mcVersion || '未知'}`);
  logger.info(`加载器   : ${plan.meta.loader || '未知'}`);
  logger.info(`文件总数 : ${plan.meta.totalFiles}`);
  logger.info(`可下载   : ${plan.tasks.length} 个，约 ${fmtBytes(total)}`);
  if (plan.unresolved?.length) logger.info(`未解析   : ${plan.unresolved.length} 个（需 API key 或手动下载）`);
  if (flags.json) { console.log(JSON.stringify(plan.meta, null, 2)); return 0; }
  logger.info('');
  logger.info('前 20 个文件:');
  for (const t of plan.tasks.slice(0, 20)) {
    logger.info(`  ${(t.label ?? '').padEnd(52).slice(0, 52)} ${fmtBytes(t.size ?? 0).padStart(10)}  ← ${new URL(t.url).host}`);
  }
  if (plan.tasks.length > 20) logger.info(`  … 其余 ${plan.tasks.length - 20} 个`);
  return 0;
}

async function cmdMirrors(rest, flags, config, logger) {
  const sub = rest[0] ?? 'list';
  if (sub === 'list') {
    for (const m of [...BUILTIN_MIRRORS, ...(config.customMirrors ?? [])]) {
      const disabled = (config.disabledMirrors ?? []).includes(m.id);
      logger.info(`${disabled ? '✗' : '✓'} ${m.id}  ${m.name}`);
      for (const r of m.rules ?? []) logger.info(`     ${r.from} → ${r.to}`);
    }
    logger.info(`\n配置文件: ${defaultConfigPath()}`);
    return 0;
  }
  if (sub === 'test') {
    logger.info('实测各镜像规则（并发探测镜像地址与原始地址，可能较慢）…\n');
    const reports = await testMirrors(config);
    const okCount = reports.filter((r) => r.status === 'ok').length;
    const judged = reports.filter((r) => r.status === 'ok' || r.status === 'fail').length;
    const order = { ok: 0, fail: 1, 'probe-bad': 2, skip: 3 };
    for (const r of reports.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (a.ms ?? 0) - (b.ms ?? 0))) {
      const tag = r.status === 'ok' ? '\x1b[32m✓\x1b[0m'
        : r.status === 'skip' ? '\x1b[33m–\x1b[0m'
        : r.status === 'probe-bad' ? '\x1b[33m?\x1b[0m'
        : '\x1b[31m✗\x1b[0m';
      let detail;
      if (r.status === 'ok') {
        const sp = r.speedup && r.speedup > 1.05 ? `  \x1b[32m比官方快 ${r.speedup.toFixed(1)}×\x1b[0m` : '';
        detail = `镜像 ${r.ms}ms / 官方 ${r.originMs}ms${sp}`;
      } else {
        detail = r.error ?? r.note ?? `HTTP ${r.httpStatus}`;
      }
      logger.info(`${tag} ${r.rule}\n     ${detail}`);
    }
    logger.info(`\n可用 ${okCount}/${judged} 条可判定规则${reports.length - judged ? `（另有 ${reports.length - judged} 条无法判定）` : ''}`);
    return okCount ? 0 : 1;
  }
  throw new Error(`未知子命令: mirrors ${sub}（可用 list / test）`);
}

async function cmdConfig(rest, flags, config, logger) {
  const sub = rest[0] ?? 'list';
  const cfgPath = defaultConfigPath();
  if (sub === 'path') { console.log(cfgPath); return 0; }
  if (sub === 'list' || sub === 'get') {
    if (sub === 'get') {
      const key = rest[1];
      if (!key) throw new Error('请提供配置项名');
      console.log(JSON.stringify(config[key], null, 2));
      return 0;
    }
    console.log(JSON.stringify(config, null, 2));
    logger.info(`\n配置文件: ${cfgPath}`);
    return 0;
  }
  if (sub === 'set') {
    const key = rest[1];
    let val = rest[2];
    if (!key) throw new Error('用法: mcboost config set <key> <value>');
    if (!(key in defaultConfig())) throw new Error(`未知配置项: ${key}\n可用项: ${Object.keys(defaultConfig()).join(', ')}`);
    if (val === undefined) throw new Error('请提供值');
    // 类型对齐
    const def = defaultConfig()[key];
    if (typeof def === 'number') val = Number(val);
    else if (typeof def === 'boolean') val = val === 'true' || val === '1' || val === 'yes';
    else if (Array.isArray(def)) { try { val = JSON.parse(val); } catch { throw new Error('该项需要 JSON 数组'); } }
    config[key] = val;
    await saveConfig(config);
    logger.info(`已设置 ${key} = ${JSON.stringify(val)}`);
    return 0;
  }
  if (sub === 'reset') {
    await saveConfig(defaultConfig());
    logger.info(`已重置为默认配置: ${cfgPath}`);
    return 0;
  }
  throw new Error(`未知子命令: config ${sub}（可用 list/get/set/path/reset）`);
}

async function cmdProxy(rest, flags, config, logger) {
  const { startProxy, encodeTarget } = await import('../src/proxy.js');
  const port = Number(flags.port ?? 8788);
  const { summary } = await startProxy({
    port,
    host: flags.host ?? '127.0.0.1',
    config,
    logger,
  });
  // 打印一次统计后退出；常驻由调用方控制
  const showStats = () => {
    const s = summary();
    logger?.info(
      `\r[proxy] 请求 ${s.requests} 次 | 加速 ${s.accelerated} | 转发 ${s.direct} | ` +
      `已传 ${fmtBytes(s.bytes)} | 平均 ${fmtSpeed(s.avgSpeed)} | 缓存 ${s.cacheDir}`.padEnd(120)
    );
  };
  const timer = setInterval(showStats, 5000);
  return new Promise(() => {}); // 常驻
}

async function cmdSearch(rest, flags, config, logger) {
  const query = rest.join(' ');
  if (!query) throw new Error('请提供搜索关键词，例如：mcboost search 红石');
  const { searchPacks } = await import('../src/packs/search.js');
  const results = await searchPacks(query, {
    limit: Number(flags.limit ?? 20),
    platform: flags.platform ?? 'all',
    signal: undefined,
  });
  if (!results.length) {
    logger?.info('没有找到匹配的整合包。试试英文关键词，或换 --platform modrinth / curseforge。');
    return 0;
  }
  logger?.info(`\n搜索 "${query}" 得到 ${results.length} 个整合包：\n`);
  for (const [i, r] of results.entries()) {
    const dl = r.downloads ? `${(r.downloads / 10000).toFixed(0)}万次` : '—';
    const ver = r.gameVersions?.slice(-2).join('/') || '?';
    logger?.info(
      `  \x1b[1m${String(i + 1).padStart(2)}.\` ${r.title}\x1b[0m  \x1b[36m[${r.platform}]\x1b[0m`
    );
    logger?.info(
      `      ${String(r.author ?? '').padEnd(14).slice(0, 14)} MC ${ver.padEnd(12)} 下载 ${dl.padEnd(8)} ${(r.summary ?? '').slice(0, 50)}`
    );
    logger?.info(`      \x1b[2m${r.slug}\x1b[0m`);
  }
  logger?.info(`\n用法：mcboost pack <编号或slug> 直接下载安装，例如 mcboost pack ${results[0].slug}`);
  return 0;
}

async function cmdWeb(rest, flags, config, logger) {
  const { startWebServer } = await import('../src/ui/server.js');
  const port = Number(flags.port ?? 8787);
  const host = flags.host ?? '0.0.0.0';
  await startWebServer({ port, host, config, logger });
  return new Promise(() => {}); // 常驻
}

async function cmdDoctor(flags, config, logger) {
  logger.info('mcboost 环境检查\n');
  logger.info(`Node.js        : ${process.version}  (${process.platform}/${process.arch})`);
  logger.info(`CPU 核心       : ${(await import('node:os')).cpus().length}`);
  const aria = await detectAria2(config.aria2Path);
  logger.info(`aria2c         : ${aria ? `\x1b[32m可用\x1b[0m v${aria.version}` : '\x1b[33m未安装\x1b[0m（将使用内置分片引擎）'}`);
  logger.info(`配置文件       : ${defaultConfigPath()}`);
  logger.info(`默认并发       : ${config.concurrency} 文件 × ${config.connections} 连接`);
  logger.info(`镜像开关       : ${config.useMirrors === false ? '关闭' : '开启'}`);
  logger.info(`CurseForge key : ${config.curseforgeApiKey || process.env.CURSEFORGE_API_KEY ? '已配置' : '未配置（老版本整合包解析会受限）'}`);
  logger.info('\n网络连通性（探测真实文件，非 CDN 根目录）:');
  const hosts = [
    ['Modrinth API', 'https://api.modrinth.com/v2/project/sodium'],
    ['Modrinth CDN', 'https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium-fabric-0.5.13%2Bmc1.20.1.jar'],
    ['CurseForge CDN', 'https://mediafilez.forgecdn.net/files/9206/523/jei-26.3-neoforge-31.13.0.71.jar'],
    ['cfwidget', 'https://api.cfwidget.com/238222'],
    ['BMCLAPI 镜像', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'],
    ['Mojang 官方', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'],
  ];
  for (const [name, url] of hosts) {
    const r = await measure(url, { bytes: 16 * 1024, timeout: 12_000 });
    logger.info(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name.padEnd(16)} ${r.ok ? `${String(r.ttfb).padStart(5)}ms 首字节` : (r.error ?? '不可达')}`);
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    process.stderr.write(`\n\x1b[31m错误:\x1b[0m ${err.message}\n`);
    if (process.env.MCBOOST_DEBUG) console.error(err);
    process.exitCode = 1;
  });
