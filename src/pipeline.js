/**
 * 主流程编排：识别整合包 → 解析文件清单 → 并发加速下载 → 释放 overrides → 汇总。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DownloadQueue } from './engine/queue.js';
import { detectAria2 } from './engine/aria.js';
import { downloadSegmented } from './engine/segment.js';
import { ProgressRenderer } from './progress.js';
import { parseManifest, resolveCurseForgeFiles, curseforgeCdnUrls } from './packs/curseforge.js';
import { parseMrpackIndex, buildMrpackTasks, extractMrpackOverrides, detectPackType, resolveModrinthPack } from './packs/modrinth.js';
import { extractZip, readZipFile, listZip } from './packs/zip.js';
import { candidatesFor } from './mirrors.js';
import { ensureDir, fmtBytes, fmtSpeed, fmtDuration, safeFileName } from './util.js';

/**
 * 缓存目录。整合包本体缓存到用户的 cache 目录，
 * 而不是当前工作目录 —— 下载工具不应该往用户的项目目录里丢东西。
 */
export function defaultCacheDir() {
  const base = process.env.XDG_CACHE_HOME
    || (process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
      : path.join(os.homedir(), '.cache'));
  return path.join(base, 'mcboost');
}

/** 选择下载引擎 */
export async function pickEngine(config, logger) {
  if (config.engine === 'aria2') {
    const info = await detectAria2(config.aria2Path);
    if (!info) throw new Error(`配置要求使用 aria2，但找不到可执行文件: ${config.aria2Path}`);
    return { engine: 'aria2', info };
  }
  if (config.engine === 'builtin') return { engine: 'builtin', info: null };
  const info = await detectAria2(config.aria2Path);
  if (info) {
    logger?.debug?.(`检测到 aria2c ${info.version}，使用 aria2 后端`);
    return { engine: 'aria2', info };
  }
  logger?.debug?.('未检测到 aria2c，使用内置分片引擎');
  return { engine: 'builtin', info: null };
}

/** 读取整合包内容（本地文件或远程 URL） */
export async function loadPackBuffer(input, { config, logger, signal, cacheDir }) {
  if (/^https?:\/\//i.test(input)) {
    const dir = cacheDir ?? defaultCacheDir();
    await ensureDir(dir);
    const name = safeFileName(decodeURIComponent(new URL(input).pathname.split('/').pop() || 'pack.zip')) || 'pack.zip';
    const dest = path.join(dir, name);
    const existing = await fsp.stat(dest).then((s) => s.size, () => 0);
    if (existing > 0) {
      logger?.info(`已缓存整合包: ${dest}`);
      return { buf: await fsp.readFile(dest), path: dest, fromCache: true };
    }
    logger?.info(`下载整合包: ${input}`);
    const engine = await pickEngine(config, logger);
    if (engine.engine === 'aria2') {
      const { ariaDownload } = await import('./engine/aria.js');
      await ariaDownload([input], dest, { connections: config.connections, bin: config.aria2Path, signal, timeout: config.timeout });
    } else {
      await downloadSegmented(input, dest, { connections: config.connections, signal, timeout: config.timeout, minSegmentSize: config.minSegmentSize });
    }
    return { buf: await fsp.readFile(dest), path: dest, fromCache: false };
  }
  const buf = await fsp.readFile(input);
  return { buf, path: path.resolve(input), fromCache: false };
}

/**
 * 统一入口解析：允许三种输入
 *   1. 本地整合包文件路径
 *   2. 整合包下载 URL
 *   3. Modrinth 项目 slug / ID（自动查最新版并下载 .mrpack 到缓存）
 * @returns {Promise<{input:string, kind:'file'|'url'|'modrinth', pack?:object}>}
 */
export async function resolveInput(input, { config, logger, signal } = {}) {
  if (input === '-') return { input: '-', kind: 'file' };
  if (/^https?:\/\//i.test(input)) return { input, kind: 'url' };
  const isFile = await fsp.stat(input).then((s) => s.isFile(), () => false);
  if (isFile) return { input: path.resolve(input), kind: 'file' };

  // 当作 Modrinth slug 处理
  logger?.info(`本地没有 "${input}"，尝试当作 Modrinth 整合包查询…`);
  const pack = await resolveModrinthPack(input, undefined, { signal });
  logger?.info(`找到: \x1b[1m${pack.name}\x1b[0m ${pack.versionNumber}  (MC ${pack.gameVersions.join('/')}, ${pack.loaders.join('/')})`);
  const dir = defaultCacheDir();
  const dest = path.join(dir, safeFileName(pack.fileName));
  const already = await fsp.stat(dest).then((s) => s.size, () => 0);
  if (already > 0) {
    logger?.info(`使用已缓存的整合包: ${dest}`);
  } else {
    const { engine, info } = await pickEngine(config, logger);
    logger?.info(`下载整合包本体: ${pack.fileName} (${fmtBytes(pack.size ?? 0)})  引擎=${engine === 'aria2' ? `aria2c ${info?.version ?? ''}` : '内置分片'}`);
    if (engine === 'aria2') {
      const { ariaDownload } = await import('./engine/aria.js');
      await ariaDownload([pack.url], dest, {
        connections: config.connections, bin: config.aria2Path, signal, timeout: config.timeout, size: pack.size,
      });
    } else {
      await downloadSegmented(pack.url, dest, {
        connections: config.connections, minSegmentSize: config.minSegmentSize,
        size: pack.size, timeout: config.timeout, signal,
      });
    }
  }
  return { input: dest, kind: 'modrinth', pack };
}

/**
 * 构造下载上下文。核心是共享一个 SourceRanker：
 * 同一批 CDN 只实测一次，避免每个文件都花 2 秒测速。
 */
export async function createContext(config, { logger, engine, connections, signal } = {}) {
  const { SourceRanker } = await import('./engine/probe.js');
  const ranker = config.autoSelectSource === false ? null : new SourceRanker({ logger });
  return {
    config,
    logger,
    engine,
    signal,
    connections: connections ?? config.connections,
    ranker,
  };
}

/**
 * 把整合包解析成下载任务列表。
 * @returns {{tasks:Array, meta:object, unresolved:Array, warnings:string[], buf:Buffer}}
 */
export async function planPack(input, { config, logger, signal, side = 'client', instanceDir, forceType }) {
  const resolved = await resolveInput(input, { config, logger, signal });
  const { buf, path: packPath } = await loadPackBuffer(resolved.input, { config, logger, signal });
  const detected = forceType ? { type: forceType } : detectPackType(buf);
  const type = detected.type;

  if (type === 'modrinth') {
    const indexBuf = readZipFile(buf, detected.entry ?? 'modrinth.index.json');
    if (!indexBuf) throw new Error('无法从 .mrpack 中读取 modrinth.index.json');
    const index = parseMrpackIndex(indexBuf);
    const tasks = buildMrpackTasks(index, instanceDir, config, { side });
    return {
      type: 'modrinth',
      buf,
      packPath,
      index,
      tasks,
      unresolved: [],
      warnings: [],
      meta: {
        name: index.name,
        version: index.versionId,
        mcVersion: index.dependencies.minecraft ?? '',
        loader: Object.keys(index.dependencies).filter((k) => k !== 'minecraft').join(', '),
        totalFiles: index.files.length,
      },
    };
  }

  if (type === 'curseforge') {
    const manifestBuf = readZipFile(buf, detected.entry ?? 'manifest.json');
    if (!manifestBuf) throw new Error('无法从整合包中读取 manifest.json');
    const manifest = parseManifest(manifestBuf);
    logger?.info(`整合包: ${manifest.name} ${manifest.version}  (MC ${manifest.mcVersion})`);
    logger?.info(`正在解析 ${manifest.files.length} 个文件的下载地址…`);
    const { resolved, unresolved, warnings } = await resolveCurseForgeFiles(manifest.files, { config, logger, signal });
    const tasks = resolved.map((r, i) => ({
      id: `cf-${i}`,
      label: r.fileName,
      url: r.urls[0],
      candidates: r.urls.flatMap((u) => candidatesFor(u, config)),
      dest: path.join(instanceDir, 'mods', safeFileName(r.fileName)),
      size: r.size,
      hashes: null,
      group: '模组',
      source: 'curseforge',
      display: r.display,
    }));
    return {
      type: 'curseforge',
      buf,
      packPath,
      manifest,
      tasks,
      unresolved,
      warnings,
      meta: {
        name: manifest.name,
        version: manifest.version,
        mcVersion: manifest.mcVersion,
        loader: manifest.modLoaders.map((l) => l.id).join(', '),
        totalFiles: manifest.files.length,
        overridesDir: manifest.overridesDir,
      },
    };
  }

  throw new Error(
    `无法识别整合包格式（不是有效的 .mrpack 或 CurseForge 整合包）。\n` +
    `  压缩包内条目: ${(detected.entries ?? []).join(', ') || '无'}`
  );
}

/**
 * 完整流程：解析 + 下载 + 释放 overrides。
 */
export async function runPack(input, opts = {}) {
  const {
    config,
    logger,
    signal,
    outDir = process.cwd(),
    instanceName,
    side = 'client',
    dryRun = false,
    concurrency,
    connections,
    showProgress = true,
    include,
    onEvent,
  } = opts;

  const plan = await planPack(input, { config, logger, signal, side, instanceDir: '' });
  // instanceDir 依赖 meta 里的名字，这里补算
  const name = instanceName || plan.meta.name || 'instance';
  const instanceDir = path.isAbsolute(outDir) ? path.join(outDir, safeFileName(name)) : path.resolve(outDir, safeFileName(name));

  // 重建任务目标路径（planPack 时 instanceDir 还是空的）
  if (plan.type === 'curseforge') {
    for (const t of plan.tasks) t.dest = path.join(instanceDir, 'mods', safeFileName(path.basename(t.dest)));
  } else if (plan.type === 'modrinth') {
    const indexBuf = readZipFile(plan.buf, 'modrinth.index.json');
    const index = parseMrpackIndex(indexBuf);
    plan.tasks = buildMrpackTasks(index, instanceDir, config, { side });
  }

  let tasks = plan.tasks;
  if (include) {
    const re = new RegExp(include, 'i');
    const before = tasks.length;
    tasks = tasks.filter((t) => re.test(t.label ?? t.dest));
    logger?.info(`按 --include /${include}/ 过滤: ${before} → ${tasks.length} 个文件`);
  }
  if (!tasks.length) {
    logger?.warn('没有需要下载的文件（可能都已被过滤或已存在）');
  }

  const totalBytes = tasks.reduce((a, t) => a + (t.size ?? 0), 0);
  logger?.info('');
  logger?.info(`📦 ${plan.meta.name}${plan.meta.version ? ` ${plan.meta.version}` : ''}`);
  logger?.info(`   游戏版本 : ${plan.meta.mcVersion || '未知'}`);
  logger?.info(`   加载器   : ${plan.meta.loader || '未知'}`);
  logger?.info(`   目标目录 : ${instanceDir}`);
  logger?.info(`   待下载   : ${tasks.length} 个文件${totalBytes ? `（约 ${fmtBytes(totalBytes)}）` : ''}`);
  for (const w of plan.warnings ?? []) logger?.warn(w);

  if (dryRun) {
    logger?.info('');
    logger?.info('— 计划（--dry-run，不实际下载）—');
    for (const t of tasks.slice(0, 40)) {
      logger?.info(`   ${t.label ?? path.basename(t.dest)}  ${t.size ? fmtBytes(t.size) : ''}  ← ${new URL(t.url).host}`);
    }
    if (tasks.length > 40) logger?.info(`   … 其余 ${tasks.length - 40} 个`);
    return { plan, tasks, instanceDir, dryRun: true };
  }

  await ensureDir(instanceDir);
  const { engine: engineName } = await pickEngine(config, logger);
  logger?.info(`   下载引擎 : ${engineName === 'aria2' ? 'aria2c' : '内置多连接分片引擎'}（并发文件 ${concurrency ?? config.concurrency} × 每文件 ${connections ?? config.connections} 连接）`);
  logger?.info('');

  const progress = showProgress ? new ProgressRenderer() : null;
  progress?.setSummary({ total: tasks.length, done: 0, skipped: 0, failed: 0 });
  progress?.setTotalBytesKnown(totalBytes || undefined);

  const ctrl = signal;
  // 全局共享的选源排序器：同一批 CDN 只探测一次，避免每个文件都花 2 秒测速
  const ctx = await createContext(
    { ...config, connections: connections ?? config.connections },
    { logger, engine: engineName, connections: connections ?? config.connections, signal: ctrl }
  );
  const ranker = ctx.ranker;

  // 连接数总预算：并发文件数 × 每文件连接数的量级。
  // 队列会按文件大小加权分配，并在小文件结束后把额度让渡给大文件。
  const maxConnections = (concurrency ?? config.concurrency) * (connections ?? config.connections);
  const queue = new DownloadQueue({
    concurrency: concurrency ?? config.concurrency,
    maxConnections,
    ctx,
  });

  const failures = [];
  const sourceStats = new Map();

  // 结构化事件流：Web UI / 外部集成通过 onEvent 消费
  const emit = (ev) => { try { onEvent?.(ev); } catch { /* 事件消费者出错不应影响下载 */ } };

  emit({ type: 'plan', meta: plan.meta, type_: plan.type, instanceDir, taskCount: tasks.length, totalBytes });

  queue.on('task:start', (task, info) => {
    progress?.setTask(task.id, { label: task.label ?? path.basename(task.dest), downloaded: 0, total: task.size ?? 0 });
    progress?.render();
    emit({
      type: 'task:start', id: task.id, label: task.label ?? path.basename(task.dest),
      size: task.size ?? null, connections: info?.connections ?? null,
    });
  });
  queue.on('progress', (task, downloaded, total) => {
    progress?.setTask(task.id, { label: task.label ?? path.basename(task.dest), downloaded, total: total || task.size || 0 });
    progress?.render();
    emit({ type: 'task:progress', id: task.id, downloaded, total: total || task.size || 0 });
  });
  queue.on('task:source', (task, info) => {
    const key = info.source;
    sourceStats.set(key, (sourceStats.get(key) ?? 0) + 1);
    emit({ type: 'task:source', id: task.id, source: info.source, cached: info.cached });
  });
  queue.on('task:done', (task, result) => {
    progress?.removeTask(task.id);
    progress?.addBytes(result.bytes ?? 0);
    progress?.setSummary({
      total: tasks.length,
      done: queue.stats.done,
      skipped: queue.stats.skipped,
      failed: queue.stats.failed,
    });
    progress?.render(true);
    emit({
      type: 'task:done', id: task.id, label: task.label ?? path.basename(task.dest),
      status: result.status, size: result.size, bytes: result.bytes,
      speed: result.speed, source: result.source, engine: result.engine,
      done: queue.stats.done, skipped: queue.stats.skipped, failed: queue.stats.failed,
      totalBytesDone: progress?.totalBytes ?? 0, totalBytes,
    });
  });
  queue.on('task:failed', (task, err) => {
    progress?.removeTask(task.id);
    failures.push({ task, error: err.message });
    progress?.setSummary({ total: tasks.length, done: queue.stats.done, skipped: queue.stats.skipped, failed: queue.stats.failed });
    progress?.log(`\x1b[31m✗\x1b[0m ${task.label ?? path.basename(task.dest)} — ${err.message}`);
    emit({
      type: 'task:failed', id: task.id, label: task.label ?? path.basename(task.dest),
      error: err.message, done: queue.stats.done, skipped: queue.stats.skipped, failed: queue.stats.failed,
      totalBytesDone: progress?.totalBytes ?? 0, totalBytes,
    });
  });

  const stats = await queue.run(tasks);
  progress?.render(true);
  progress?.stop();

  // —— 释放 overrides ——
  let overridesWritten = 0;
  try {
    if (plan.type === 'modrinth') {
      const ov = await extractMrpackOverrides(plan.buf, instanceDir);
      overridesWritten = ov.written;
    } else if (plan.type === 'curseforge') {
      const ov = await extractZip(plan.buf, instanceDir, { stripPrefix: (plan.meta.overridesDir || 'overrides') + '/' });
      overridesWritten = ov.written;
    }
  } catch (err) {
    logger?.warn(`释放 overrides 失败: ${err.message}`);
  }
  if (overridesWritten) logger?.info(`已释放 overrides 配置: ${overridesWritten} 个文件`);

  // —— 失败/未解析清单 ——
  const manual = [...(plan.unresolved ?? []).map((u) => ({
    name: `project ${u.projectID} / file ${u.fileID}`,
    reason: u.reason,
    url: `https://www.curseforge.com/projects/${u.projectID}/files/${u.fileID}`,
  })), ...failures.map((f) => ({ name: f.task.label ?? path.basename(f.task.dest), reason: f.error, url: f.task.url }))];

  if (manual.length) {
    const listPath = path.join(instanceDir, '待手动下载.txt');
    const lines = [
      `以下 ${manual.length} 个文件未能自动下载，请手动补齐：`,
      '',
      ...manual.map((m, i) => `${i + 1}. ${m.name}\n   原因: ${m.reason}\n   地址: ${m.url}`),
      '',
    ];
    await fsp.writeFile(listPath, lines.join('\n'), 'utf8');
    logger?.warn(`有 ${manual.length} 个文件未完成，清单已写入: ${listPath}`);
  }

  // —— 汇总 ——
  const elapsed = stats.elapsed || 0.001;
  logger?.info('');
  logger?.info('══════════ 下载完成 ══════════');
  logger?.info(`  成功     : ${stats.done} 个文件`);
  if (stats.skipped) logger?.info(`  已存在跳过: ${stats.skipped} 个文件`);
  if (stats.failed) logger?.info(`  失败     : ${stats.failed} 个文件`);
  logger?.info(`  实际下载 : ${fmtBytes(stats.bytes)}`);
  logger?.info(`  总耗时   : ${fmtDuration(elapsed)}`);
  logger?.info(`  平均速度 : ${fmtSpeed(stats.bytes / elapsed)}`);
  if (sourceStats.size) {
    const top = [...sourceStats.entries()].sort((a, b) => b[1] - a[1]);
    logger?.info(`  选源分布 : ${top.map(([k, v]) => `${k}×${v}`).join('  ')}`);
  }
  if (ranker && (ranker.probes || ranker.hits)) {
    logger?.info(`  测速缓存 : 实际探测 ${ranker.probes} 次，命中缓存 ${ranker.hits} 次（${ranker.size} 组源）`);
  }
  logger?.info(`  输出目录 : ${instanceDir}`);
  logger?.info('══════════════════════════════');

  return { plan, tasks, instanceDir, stats, failures, manual };
}
