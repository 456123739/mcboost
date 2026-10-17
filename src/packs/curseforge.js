/**
 * CurseForge 整合包支持。
 *
 * 整合包 zip 里的 `manifest.json` 只记录 (projectID, fileID)，不记录文件名和直链。
 * 而 CurseForge 官方 API 需要 API key（无 key 直接 403）。
 *
 * 本模块用两级策略解析：
 *   1. 配了 API key → 走官方 api.curseforge.com（最权威，含 downloadUrl）
 *   2. 没配 key    → 走公开的 cfwidget 接口拿「文件名 + 大小」，
 *                    再用 CurseForge CDN 的确定性路径规则拼出直链：
 *                      https://mediafilez.forgecdn.net/files/{⌊id/1000⌋}/{id%1000}/{文件名}
 *                    （该规则已实测验证，返回 206 + 正确的 ZIP 魔数）
 */
import { getJson, request } from '../net/http.js';
import { pool } from '../util.js';

const CF_API = 'https://api.curseforge.com/v1';
const CFWIDGET = 'https://api.cfwidget.com';

/** CurseForge CDN 的确定性直链（含编码/字面两种等价写法，便于回退） */
export function curseforgeCdnUrls(fileId, fileName) {
  const a = Math.floor(fileId / 1000);
  const b = fileId % 1000;
  const base = `https://mediafilez.forgecdn.net/files/${a}/${b}/`;
  const encoded = base + encodeURIComponent(fileName);
  const literal = base + fileName.replace(/ /g, '%20');
  return encoded === literal ? [encoded] : [encoded, literal];
}

/** 解析 manifest.json */
export function parseManifest(buf) {
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new Error(`manifest.json 解析失败: ${err.message}`);
  }
  const mc = json.minecraft ?? {};
  return {
    name: json.name ?? '未命名整合包',
    version: json.version ?? '',
    author: json.author ?? '',
    mcVersion: mc.version ?? '',
    modLoaders: (mc.modLoaders ?? []).map((l) => ({ id: l.id, primary: !!l.primary })),
    overridesDir: json.overrides ?? 'overrides',
    files: (json.files ?? []).map((f) => ({
      projectID: f.projectID,
      fileID: f.fileID,
      required: f.required !== false,
    })),
  };
}

/** 主加载器（用于选择对应的 loader 安装源） */
export function primaryLoader(manifest) {
  const p = manifest.modLoaders.find((l) => l.primary) ?? manifest.modLoaders[0];
  return p?.id ?? '';
}

/**
 * 用 cfwidget 拿某个项目下所有（近期）文件的元信息。
 * cfwidget 较慢，所以按项目缓存 + 限并发。
 */
async function fetchProjectViaCfwidget(projectId, { timeout = 30_000, signal } = {}) {
  const data = await getJson(`${CFWIDGET}/${projectId}`, { timeout, retries: 2, signal });
  const files = new Map();
  for (const f of data.files ?? []) {
    files.set(Number(f.id), { fileName: f.name, size: f.filesize ?? null, display: f.display ?? '' });
  }
  if (data.download?.id) {
    files.set(Number(data.download.id), {
      fileName: data.download.name,
      size: data.download.filesize ?? null,
      display: data.download.display ?? '',
    });
  }
  return { title: data.title ?? '', files, urls: data.urls ?? {} };
}

/** 用官方 API 拿单个文件（需要 key） */
async function fetchFileViaApi(projectId, fileId, apiKey, { timeout = 30_000, signal } = {}) {
  const data = await getJson(`${CF_API}/mods/${projectId}/files/${fileId}`, {
    timeout, retries: 2, signal,
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  const d = data.data;
  if (!d) return null;
  return {
    fileName: d.fileName,
    size: d.fileLength ?? null,
    downloadUrl: d.downloadUrl ?? null,
    display: d.displayName ?? '',
  };
}

/**
 * 解析整合包里的所有 (projectID, fileID) → 可下载任务信息。
 *
 * @returns {{resolved: Array, unresolved: Array, warnings: string[]}}
 */
export async function resolveCurseForgeFiles(files, opts = {}) {
  const {
    config = {},
    signal,
    logger,
    concurrency = 4,
    onProgress,
  } = opts;

  const apiKey = config.curseforgeApiKey || process.env.CURSEFORGE_API_KEY || '';
  const warnings = [];
  const resolved = [];
  const unresolved = [];

  // 按项目分组，减少请求次数
  const byProject = new Map();
  for (const f of files) {
    if (!byProject.has(f.projectID)) byProject.set(f.projectID, []);
    byProject.get(f.projectID).push(f);
  }
  const projectIds = [...byProject.keys()];
  const projectCache = new Map();
  let done = 0;

  await pool(projectIds, Math.max(1, Math.min(concurrency, 6)), async (pid) => {
    if (signal?.aborted) return;
    try {
      let info;
      if (apiKey) {
        info = { title: '', files: new Map(), urls: {} };
        for (const f of byProject.get(pid)) {
          try {
            const one = await fetchFileViaApi(pid, f.fileID, apiKey, { signal, timeout: config.timeout });
            if (one) info.files.set(Number(f.fileID), one);
          } catch (err) {
            logger?.debug?.(`官方 API 解析失败 ${pid}/${f.fileID}: ${err.message}`);
          }
        }
      } else {
        info = await fetchProjectViaCfwidget(pid, { signal, timeout: Math.max(config.timeout ?? 30_000, 30_000) });
      }
      projectCache.set(pid, info);
    } catch (err) {
      projectCache.set(pid, { error: err.message, files: new Map(), urls: {} });
    }
    done++;
    onProgress?.(done, projectIds.length, pid);
  });

  for (const f of files) {
    const info = projectCache.get(f.projectID);
    const key = `${f.projectID}/${f.fileID}`;
    if (!info || info.error) {
      unresolved.push({ ...f, key, reason: info?.error ? `查询失败: ${info.error}` : '查询失败' });
      continue;
    }
    const meta = info.files.get(Number(f.fileID));
    if (!meta?.fileName) {
      unresolved.push({
        ...f, key,
        reason: apiKey ? 'API 未返回该文件' : 'cfwidget 未收录该文件（多为较老的版本）',
      });
      continue;
    }
    const urls = [];
    if (meta.downloadUrl) urls.push(meta.downloadUrl);
    urls.push(...curseforgeCdnUrls(f.fileID, meta.fileName));
    resolved.push({
      key,
      projectID: f.projectID,
      fileID: f.fileID,
      required: f.required,
      fileName: meta.fileName,
      size: meta.size ?? null,
      display: meta.display || info.title || '',
      urls: [...new Set(urls)],
      source: 'curseforge',
    });
  }

  if (unresolved.length && !apiKey) {
    warnings.push(
      `有 ${unresolved.length} 个文件无法自动解析（cfwidget 只收录较新版本）。\n` +
      `  解决办法：在 https://console.curseforge.com/ 申请免费 API key 后执行：\n` +
      `    mcboost config set curseforgeApiKey <你的key>\n` +
      `  这样可以用官方接口解析全部文件。`
    );
  }

  return { resolved, unresolved, warnings };
}

/** 下载一份 CurseForge 整合包 zip 的 manifest（用于 --from-url） */
export async function fetchManifestFromUrl(url, { signal, timeout = 45_000 } = {}) {
  const res = await request(url, { signal, timeout, retries: 3 });
  if (!res.ok) throw new Error(`下载整合包失败: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
