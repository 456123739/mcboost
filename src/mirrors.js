/**
 * 镜像 / 多源规则。
 *
 * 设计目标：给定一个原始下载 URL，生成一组「候选 URL」，
 * 由测速器挑选最快的那个。规则分两类：
 *   1. prefix  —— 把某个前缀替换成镜像前缀（用于 BMCLAPI 这类路径兼容镜像）
 *   2. hostSwap —— 只换域名、路径不变（用于同一 CDN 的多个入口）
 *
 * 所有内置规则都可以在 `mcboost mirrors test` 中实测验证；
 * 未通过验证的规则会被标记，不会默认参与竞速。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deepMerge } from './util.js';
import { request } from './net/http.js';

/** 内置镜像源。每条规则都经过 `mcboost mirrors test` 实测，未通过的已剔除。 */
export const BUILTIN_MIRRORS = [
  {
    id: 'bmclapi',
    name: 'BMCLAPI（国内公益镜像：Mojang / Forge / Fabric Meta）',
    enabled: true,
    kind: 'prefix',
    rules: [
      { from: 'https://launchermeta.mojang.com/', to: 'https://bmclapi2.bangbang93.com/' },
      { from: 'https://piston-meta.mojang.com/', to: 'https://bmclapi2.bangbang93.com/' },
      { from: 'https://piston-data.mojang.com/', to: 'https://bmclapi2.bangbang93.com/' },
      { from: 'https://launcher.mojang.com/', to: 'https://bmclapi2.bangbang93.com/' },
      // 注意：BMCLAPI 的 /maven/ 只代理 Forge 系 maven，实测 **不代理** Fabric maven
      //（maven.fabricmc.net 的构件在 BMCLAPI 上返回 404），因此这里不添加该映射，
      // 否则会导致 Fabric 模组全部下载失败。
      { from: 'https://libraries.minecraft.net/', to: 'https://bmclapi2.bangbang93.com/maven/' },
      { from: 'https://maven.minecraftforge.net/', to: 'https://bmclapi2.bangbang93.com/maven/' },
      { from: 'https://maven.neoforged.net/', to: 'https://bmclapi2.bangbang93.com/maven/' },
      { from: 'https://resources.download.minecraft.net/', to: 'https://bmclapi2.bangbang93.com/assets/' },
      { from: 'https://meta.fabricmc.net/', to: 'https://bmclapi2.bangbang93.com/fabric-meta/' },
    ],
  },
  {
    id: 'forgecdn-repair',
    name: 'CurseForge CDN 域名修复（老整合包里的死链域名 → 可用域名）',
    enabled: true,
    kind: 'hostSwap',
    rules: [
      // 实测：mediafilez.forgecdn.net 正常；edge / media 这两个老域名对同一路径返回 404/403。
      // 老整合包 manifest 里若残留这些域名，重写后即可正常下载。
      { from: 'edge.forgecdn.net', to: 'mediafilez.forgecdn.net' },
      { from: 'media.forgecdn.net', to: 'mediafilez.forgecdn.net' },
      // 反向不成立：mediafilez 上存在的文件在 edge 上是 404，所以不做 mediafilez → edge 映射。
    ],
  },
];

/**
 * 每条规则的健康探针。
 * 必须是**真实存在**的文件，否则会把 404 误判成镜像不可用。
 * prefix 类规则用同一条路径拼到镜像前缀上；hostSwap 类规则只换域名、路径不变。
 */
const MIRROR_PROBES = {
  'https://launchermeta.mojang.com/': 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  'https://piston-meta.mojang.com/': 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://piston-data.mojang.com/': 'https://piston-data.mojang.com/mc/game/version_manifest_v2.json',
  'https://launcher.mojang.com/': 'https://launcher.mojang.com/mc/game/version_manifest_v2.json',
  // 真实存在的库文件（guava 是几乎所有版本的依赖）
  'https://libraries.minecraft.net/': 'https://libraries.minecraft.net/com/google/guava/guava/32.1.2-jre/guava-32.1.2-jre.pom',
  'https://maven.minecraftforge.net/': 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
  'https://maven.neoforged.net/': 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
  // 真实资源哈希（1.20.1 asset index 中的一项），不能随便造
  'https://resources.download.minecraft.net/': 'https://resources.download.minecraft.net/b6/b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356',
  'https://meta.fabricmc.net/': 'https://meta.fabricmc.net/v2/versions/loader',
  // hostSwap 探针只需提供一条在目标 CDN 上真实存在的路径
  'mediafilez.forgecdn.net': 'https://mediafilez.forgecdn.net/files/9206/523/jei-26.3-neoforge-31.13.0.71.jar',
  'edge.forgecdn.net': 'https://edge.forgecdn.net/files/9206/523/jei-26.3-neoforge-31.13.0.71.jar',
  'media.forgecdn.net': 'https://media.forgecdn.net/files/9206/523/jei-26.3-neoforge-31.13.0.71.jar',
};

export function defaultConfigPath() {
  if (process.env.MCBOOST_CONFIG) return process.env.MCBOOST_CONFIG;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'mcboost', 'config.json');
}

export function defaultConfig() {
  return {
    // 同时下载的文件数
    concurrency: 6,
    // 单个文件的连接（分片）数
    connections: 8,
    // 小于该大小的文件不分片，直接单连接下载
    minSegmentSize: 1 * 1024 * 1024,
    // 分片大小。小分片 + 动态队列是吞吐的关键：连接被 CDN 饿死时，
    // 小分片能立刻被别的连接接手，而大分片会把整个下载拖死。
    pieceSize: 2 * 1024 * 1024,
    // 某条连接多久没收到数据就算被饿死，把分片退回队列换人
    stallMs: 12_000,
    // 选源测速：对每个文件最多探测几个候选源
    probeCandidates: 3,
    // 是否启用测速选源（关闭则只用主源，失败时再回退镜像）
    autoSelectSource: true,
    // 测速时每条流最多读多少字节（1.5MB）
    probeBytes: 1.5 * 1024 * 1024,
    // 测速时每条流至少跑多少毫秒 —— 必须够长才能越过 TCP 慢启动，
    // 否则小样本测出来的吞吐毫无参考价值（实测会差 20 倍以上）
    probeMinMs: 2000,
    // 下载引擎：auto | aria2 | builtin
    engine: 'auto',
    // aria2c 可执行文件路径
    aria2Path: 'aria2c',
    // 下载后校验（能在 manifest 里拿到 sha1/sha512 时）
    verifyHash: true,
    // 全局镜像开关
    useMirrors: true,
    // 用户自定义镜像，结构同 BUILTIN_MIRRORS
    customMirrors: [],
    // 禁用某些内置镜像 id
    disabledMirrors: [],
    retries: 3,
    timeout: 45_000,
    // CurseForge 官方 API key（可选，配置后优先使用官方接口解析）
    curseforgeApiKey: '',
  };
}

export async function loadConfig(configPath = defaultConfigPath()) {
  const base = defaultConfig();
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    return deepMerge(base, JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return base;
    throw new Error(`配置文件解析失败 (${configPath}): ${err.message}`);
  }
}

export async function saveConfig(config, configPath = defaultConfigPath()) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return configPath;
}

/** 当前生效的镜像列表 */
export function activeMirrors(config) {
  const disabled = new Set(config.disabledMirrors || []);
  const all = [...BUILTIN_MIRRORS, ...(config.customMirrors || [])];
  if (config.useMirrors === false) return [];
  return all.filter((m) => m.enabled !== false && !disabled.has(m.id));
}

/**
 * 为原始 URL 生成候选列表（含原 URL）。返回按优先级排序的数组。
 * @returns {{url:string, source:string, mirrorId:string|null}[]}
 */
export function candidatesFor(url, config) {
  const out = [{ url, source: 'origin', mirrorId: null }];
  if (config.useMirrors === false) return out;
  const seen = new Set([url]);
  for (const mirror of activeMirrors(config)) {
    for (const rule of mirror.rules || []) {
      let next = null;
      if (mirror.kind === 'prefix') {
        if (url.startsWith(rule.from)) next = rule.to + url.slice(rule.from.length);
      } else if (mirror.kind === 'hostSwap') {
        try {
          const u = new URL(url);
          if (u.host === rule.from) {
            u.host = rule.to;
            next = u.toString();
          }
        } catch { /* 非法 URL 忽略 */ }
      }
      if (next && !seen.has(next)) {
        seen.add(next);
        out.push({ url: next, source: mirror.name || rule.to, mirrorId: mirror.id });
      }
    }
  }
  return out;
}

/** 该 URL 是否命中任何镜像规则 */
export function hasMirrorFor(url, config) {
  return candidatesFor(url, config).length > 1;
}

/**
 * 实测所有镜像规则是否可用。
 *
 * 同时探测「原始地址」和「镜像地址」：
 *   - 镜像可用            → ok，并给出相对官方源的速度倍率
 *   - 镜像失败但原始也失败 → probe-bad（探针路径本身有问题，不能据此判定镜像坏了）
 *   - 镜像失败但原始可用   → fail（镜像确实不可用）
 *
 * @returns 每个规则的健康报告
 */
export async function testMirrors(config, { timeout = 20_000 } = {}) {
  const reports = [];
  const jobs = [];

  for (const mirror of activeMirrors(config)) {
    for (const rule of mirror.rules || []) {
      jobs.push((async () => {
        const originUrl = MIRROR_PROBES[rule.from];
        const rec = { mirror: mirror.name, mirrorId: mirror.id, rule: `${rule.from} → ${rule.to}` };
        if (!originUrl) {
          rec.status = 'skip';
          rec.note = '无探针';
          reports.push(rec);
          return;
        }
        let mirrored;
        if (mirror.kind === 'prefix') mirrored = rule.to + originUrl.slice(rule.from.length);
        else {
          const u = new URL(originUrl);
          u.host = rule.to;
          mirrored = u.toString();
        }
        rec.mirrored = mirrored;

        const probe = async (url, withBody) => {
          const t0 = Date.now();
          try {
            const res = await request(url, { timeout, retries: 1, headers: { Range: 'bytes=0-63' } });
            const ms = Date.now() - t0;
            const ok = res.ok || res.status === 206;
            if (withBody) { try { await res.arrayBuffer(); } catch { /* ignore */ } }
            return { ok, status: res.status, ms };
          } catch (err) {
            return { ok: false, ms: Date.now() - t0, error: err?.cause?.code || err.message };
          }
        };

        const [m, o] = await Promise.all([probe(mirrored, true), probe(originUrl, false)]);
        rec.ms = m.ms;
        rec.httpStatus = m.status;
        rec.originMs = o.ms;
        if (m.ok) {
          rec.status = 'ok';
          if (o.ok && o.ms > 0) rec.speedup = o.ms / Math.max(1, m.ms);
        } else if (!o.ok) {
          rec.status = 'probe-bad';
          rec.note = `原始地址也不可达（HTTP ${o.status ?? o.error}），探针失效，无法判定`;
        } else {
          rec.status = 'fail';
          rec.error = m.error ?? `HTTP ${m.status}`;
        }
        reports.push(rec);
      })());
    }
  }
  await Promise.all(jobs);
  return reports;
}
