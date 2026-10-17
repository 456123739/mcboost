/**
 * Modrinth 整合包（.mrpack）支持。
 *
 * .mrpack 就是一个 zip，里面 `modrinth.index.json` 直接给出每个文件的
 * path / 大小 / sha1 / sha512 / downloads[]，**无需任何 API key**，
 * 是解析成本最低、最适合做加速下载的一类整合包。
 */
import { getJson } from '../net/http.js';
import { candidatesFor } from '../mirrors.js';
import { safeJoinPath } from '../util.js';
import { extractZip, listZip } from './zip.js';

const API = 'https://api.modrinth.com/v2';

/** 解析 modrinth.index.json */
export function parseMrpackIndex(buf) {
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new Error(`modrinth.index.json 解析失败: ${err.message}`);
  }
  return {
    formatVersion: json.formatVersion ?? 1,
    game: json.game ?? 'minecraft',
    name: json.name ?? '未命名整合包',
    versionId: json.versionId ?? '',
    summary: json.summary ?? '',
    dependencies: json.dependencies ?? {},
    files: (json.files ?? []).map((f) => ({
      path: f.path,
      size: f.fileSize ?? null,
      hashes: f.hashes ?? {},
      env: f.env ?? {},
      downloads: f.downloads ?? [],
    })),
  };
}

/** 判断某个文件在当前 side 下是否需要下载 */
export function includeForSide(env, side) {
  const v = env?.[side];
  if (side === 'client' && v === 'unsupported') return false;
  if (side === 'server' && v === 'unsupported') return false;
  return true;
}

/**
 * 把 index 转成下载任务列表。
 * @param {object} index
 * @param {string} instanceDir 整合包实例目录
 * @param {object} config
 * @param {'client'|'server'} side
 */
export function buildMrpackTasks(index, instanceDir, config, { side = 'client' } = {}) {
  const tasks = [];
  let idx = 0;
  for (const f of index.files) {
    if (!includeForSide(f.env, side)) continue;
    if (!f.downloads?.length) continue;
    const dest = safeJoinPath(instanceDir, f.path);
    // 每个 downloads 条目都可能命中镜像规则（例如自建反代）
    const cands = [];
    const seen = new Set();
    for (const url of f.downloads) {
      for (const c of candidatesFor(url, config)) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        cands.push(c);
      }
    }
    tasks.push({
      id: `mrpack-${idx++}`,
      label: f.path.replace(/^mods\//, ''),
      url: cands[0].url,
      candidates: cands,
      dest,
      size: f.size,
      hashes: f.hashes,
      group: groupOf(f.path),
      source: 'modrinth',
    });
  }
  return tasks;
}

function groupOf(p) {
  const seg = p.split('/')[0];
  const map = { mods: '模组', 'resourcepacks': '资源包', shaderpacks: '光影', config: '配置' };
  return map[seg] ?? seg;
}

/** 解压 mrpack 里的 overrides / client-overrides */
export async function extractMrpackOverrides(buf, instanceDir, { side = 'client', overwrite = true } = {}) {
  const result = { written: 0 };
  const a = await extractZip(buf, instanceDir, { stripPrefix: 'overrides/', overwrite });
  result.written += a.written;
  const sideDir = side === 'server' ? 'server-overrides/' : 'client-overrides/';
  const b = await extractZip(buf, instanceDir, { stripPrefix: sideDir, overwrite });
  result.written += b.written;
  result.clientOverrides = b.written;
  return result;
}

/**
 * 通过 Modrinth API 解析整合包版本，拿到 .mrpack 下载地址。
 * @param {string} projectSlug 项目 slug 或 ID（如 'fabulously-optimized'）
 * @param {string} [versionId] 不传则取最新版
 */
export async function resolveModrinthPack(projectSlug, versionId, { signal, timeout = 30_000 } = {}) {
  const headers = { 'User-Agent': 'mcboost/0.1 (modpack downloader)' };
  const versions = await getJson(
    versionId
      ? `${API}/version/${encodeURIComponent(versionId)}`
      : `${API}/project/${encodeURIComponent(projectSlug)}/version`,
    { signal, timeout, headers }
  );
  const list = Array.isArray(versions) ? versions : [versions];
  if (!list.length) throw new Error(`Modrinth 上找不到 ${projectSlug} 的版本`);
  const v = list[0];
  const file = (v.files ?? []).find((f) => f.primary) ?? (v.files ?? [])[0];
  if (!file?.url) throw new Error(`版本 ${v.id} 没有可下载文件`);
  return {
    projectId: v.project_id,
    versionId: v.id,
    name: v.name ?? projectSlug,
    versionNumber: v.version_number ?? '',
    gameVersions: v.game_versions ?? [],
    loaders: v.loaders ?? [],
    url: file.url,
    fileName: file.filename,
    size: file.size ?? null,
    hashes: file.hashes ?? {},
  };
}

/**
 * 探测一个 zip buffer 属于哪种整合包。
 * 通过读取中央目录里的条目名判断，比扫描字节更可靠。
 */
export function detectPackType(buf) {
  let names;
  try {
    names = listZip(buf).map((e) => e.name);
  } catch (err) {
    return { type: 'unknown', error: err.message };
  }
  const find = (n) => names.find((x) => x === n || x.endsWith('/' + n));
  const mrpack = find('modrinth.index.json');
  if (mrpack) return { type: 'modrinth', entry: mrpack };
  const manifest = find('manifest.json');
  if (manifest) return { type: 'curseforge', entry: manifest };
  return { type: 'unknown', entries: names.slice(0, 12) };
}
