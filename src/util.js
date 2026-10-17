/**
 * 通用工具函数
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 人类可读的字节数 */
export function fmtBytes(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '?';
  const neg = n < 0;
  n = Math.abs(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(v) : v.toFixed(digits);
  return `${neg ? '-' : ''}${s} ${units[i]}`;
}

/** 人类可读的速度 */
export function fmtSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  return `${fmtBytes(bytesPerSec, 1)}/s`;
}

/** 人类可读的时长 */
export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(new Error('aborted')); return; }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }
  });
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 把任意字符串净化成安全文件名（保留 Minecraft mod 文件名常见的字符）
 */
export function safeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || 'unnamed';
}

/**
 * 防止 zip 解包路径穿越（../ 逃逸）
 */
export function safeJoinPath(root, entry) {
  const normalized = path.normalize(entry).replace(/^([/\\])+/, '');
  const target = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error(`不安全的压缩包路径: ${entry}`);
  }
  return target;
}

/** 深合并简单对象 */
export function deepMerge(base, extra) {
  if (!extra) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function isDirSync(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function fileExistsSync(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export async function fileSize(p) {
  try { return (await fsp.stat(p)).size; } catch { return -1; }
}

/** 简易并发池：对 items 并发执行 fn，限制并发数 */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export class Logger {
  constructor({ verbose = false, quiet = false } = {}) {
    this.verbose = verbose;
    this.quiet = quiet;
  }
  info(msg) { if (!this.quiet) process.stderr.write(`${msg}\n`); }
  warn(msg) { if (!this.quiet) process.stderr.write(`⚠️  ${msg}\n`); }
  error(msg) { process.stderr.write(`❌ ${msg}\n`); }
  debug(msg) { if (this.verbose) process.stderr.write(`·  ${msg}\n`); }
}
