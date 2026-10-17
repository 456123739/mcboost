/**
 * 整合包搜索：Modrinth（无需 key）+ CurseForge（无需 key，走公开接口）。
 *
 * Modrinth 的搜索接口完整、无限制，是主要来源。
 * CurseForge 官方搜索接口需要 API key，所以用公开的 cfwidget 作为补充 ——
 * 它支持按关键词搜项目（虽然能力弱于官方）。没有 key 时也能找到不少包。
 */
import { getJson } from '../net/http.js';

const MR_API = 'https://api.modrinth.com/v2';
const CFWIDGET = 'https://api.cfwidget.com';

/** 搜 Modrinth 整合包 */
async function searchModrinth(query, { limit = 20, signal, mcVersion, loader } = {}) {
  const facets = [['project_type:modpack']];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(100, Math.max(1, limit))),
    index: 'relevance',
    facets: JSON.stringify(facets),
  });
  const hits = await getJson(`${MR_API}/search?${params}`, { signal, timeout: 30_000 });
  return (hits.hits ?? []).map((h) => ({
    platform: 'Modrinth',
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    author: h.author ?? '',
    summary: h.description ?? '',
    downloads: h.downloads ?? 0,
    follows: h.follows ?? 0,
    gameVersions: h.versions ?? [],
    loaders: h.categories ?? [],
    iconUrl: h.icon_url ?? null,
    dateModified: h.date_modified ?? null,
    url: `https://modrinth.com/modpack/${h.slug}`,
  }));
}

/**
 * 搜 CurseForge（公开接口，无需 key）。
 * cfwidget 只支持按项目 ID / slug 查详情，不支持全文搜索，
 * 所以这里只能做「按关键词猜 slug」+ 直接查项目，覆盖面有限；
 * 真正完整的搜索需要 API key（在 config 里配置 curseforgeApiKey 即可启用）。
 */
async function searchCurseForge(query, { limit = 20, signal, apiKey } = {}) {
  if (apiKey) {
    // 有 key 就走官方搜索，结果最全
    const params = new URLSearchParams({
      gameId: '432',               // Minecraft
      classId: '4471',             // Modpacks
      searchFilter: query,
      pageSize: String(Math.min(50, Math.max(1, limit))),
      sortField: 'Popularity',
      sortOrder: 'desc',
    });
    try {
      const d = await getJson(`https://api.curseforge.com/v1/mods/search?${params}`, {
        signal, timeout: 30_000, headers: { 'x-api-key': apiKey },
      });
      return (d.data ?? []).map((m) => ({
        platform: 'CurseForge',
        id: String(m.id),
        slug: String(m.id),
        title: m.name,
        author: m.authors?.[0]?.name ?? '',
        summary: m.summary ?? '',
        downloads: m.downloadCount ?? 0,
        gameVersions: m.latestFilesIndexes?.[0]?.gameVersion ? [m.latestFilesIndexes[0].gameVersion] : [],
        iconUrl: m.logo?.url ?? null,
        url: m.links?.websiteUrl ?? `https://www.curseforge.com/projects/${m.id}`,
      }));
    } catch { /* 退回到无 key 路径 */ }
  }

  // 无 key：把关键词拼成可能的 slug 直接查
  const guess = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const tries = [guess, query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')];
  const out = [];
  for (const t of tries) {
    if (!t) continue;
    try {
      const d = await getJson(`${CFWIDGET}/${encodeURIComponent(t)}`, { signal, timeout: 25_000 });
      if (d?.id && d?.title && out.length < limit) {
        out.push({
          platform: 'CurseForge',
          id: String(d.id),
          slug: String(d.id),
          title: d.title,
          author: d.members?.find((m) => m?.title === 'Owner')?.username ?? '',
          summary: d.summary ?? '',
          downloads: d.downloads ?? 0,
          iconUrl: d.thumbnail ?? null,
          url: d.urls?.project ?? `https://www.curseforge.com/projects/${d.id}`,
        });
      }
    } catch { /* 猜不中就跳过 */ }
  }
  return out;
}

/**
 * 搜索整合包。
 * @returns {Promise<Array>} 合并去重后的结果
 */
export async function searchPacks(query, opts = {}) {
  const { limit = 20, platform = 'all', signal } = opts;
  const jobs = [];
  if (platform === 'all' || platform === 'modrinth') {
    jobs.push(searchModrinth(query, opts).catch(() => []));
  }
  if (platform === 'all' || platform === 'curseforge') {
    jobs.push(searchCurseForge(query, { ...opts, apiKey: opts.curseforgeApiKey }).catch(() => []));
  }
  const lists = await Promise.all(jobs);
  const merged = lists.flat();
  // 按下载量排序，去掉重复标题
  const seen = new Set();
  return merged
    .filter((r) => {
      const key = `${r.platform}:${r.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    .slice(0, limit);
}
