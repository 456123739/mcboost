/**
 * aria2c 后端。
 *
 * 系统里已经有 aria2c 时，直接复用它成熟的下载内核（多连接、分片、续传、
 * 多源镜像都实现得比自研更稳）。没有就自动回退到内置引擎。
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileSize } from '../util.js';

let cachedPath = undefined;

/** 检测 aria2c 是否可用 */
export async function detectAria2(bin = 'aria2c') {
  if (cachedPath !== undefined && bin === 'aria2c') return cachedPath;
  const found = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && /aria2/i.test(out) ? parseVersion(out) : null));
  });
  if (bin === 'aria2c') cachedPath = found;
  return found;
}

function parseVersion(out) {
  const m = /aria2 version ([\d.]+)/i.exec(out);
  return { bin: 'aria2c', version: m ? m[1] : 'unknown' };
}

/** 解析 aria2 的体积字符串，如 "1.5MiB" / "191MiB" / "512B" */
export function parseAria2Size(text) {
  const m = /^([\d.]+)\s*([KMGT]?i?B)?$/i.exec(String(text).trim());
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] ?? 'B').toUpperCase();
  const mult = { B: 1, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4,
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 }[unit] ?? 1;
  return Math.round(v * mult);
}

/**
 * 从 aria2 的进度行里解出 (已下载, 总量)。
 * 形如：[#7f3b2c 12MiB/191MiB(6%) CN:8 DL:6.7MiB ETA:26s]
 */
export function parseAria2ProgressLine(line) {
  const m = /\[#\w+\s+([\d.]+\s*[KMGT]?i?B)\/([\d.]+\s*[KMGT]?i?B)\((\d+)%\)/.exec(line);
  if (!m) return null;
  const done = parseAria2Size(m[1]);
  const total = parseAria2Size(m[2]);
  if (done === null) return null;
  return { done, total };
}

/**
 * 用 aria2c 下载一个文件（可传多个同内容 URL 作为镜像）。
 *
 * 进度来源：**解析 aria2 自己的进度行**，而不是轮询文件大小。
 * 因为 aria2 用 `--file-allocation=none` 时写的是稀疏文件，
 * 落盘 size 会在第一秒就跳到接近文件总长（实测 191MB 的文件，
 * 实际只传了 28MB 时 stat 就已经是 168MB），轮询文件大小会让进度条直接假死到 100%。
 *
 * @returns {Promise<{path:string, size:number, bytes:number, engine:'aria2', resumed:boolean}>}
 */
export async function ariaDownload(urls, destPath, opts = {}) {
  const {
    connections = 8,
    onProgress,
    signal,
    timeout = 45_000,
    bin = 'aria2c',
    size: expectedSize = null,
  } = opts;

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const dir = path.dirname(destPath);
  const name = path.basename(destPath);
  const preexisting = await fileSize(destPath);

  const args = [
    '--max-connection-per-server=' + Math.max(1, connections),
    '--split=' + Math.max(1, connections),
    '--min-split-size=1M',
    '--continue=true',
    '--file-allocation=none',
    '--auto-file-renaming=false',
    '--allow-overwrite=true',
    // 每秒输出一行汇总，用于解析真实进度（关闭 \r 刷屏的实时读数）
    '--summary-interval=1',
    '--show-console-readout=false',
    '--console-log-level=warn',
    '--max-tries=' + (opts.retries ?? 4),
    '--retry-wait=2',
    '--connect-timeout=' + Math.max(5, Math.round(timeout / 1000)),
    '--timeout=' + Math.max(5, Math.round(timeout / 1000)),
    '--user-agent=' + (opts.headers?.['User-Agent'] || 'mcboost/0.1'),
    '-d', dir,
    '-o', name,
    ...urls,
  ];

  let lastReported = 0;
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`无法启动 aria2c: ${err.message}`));
      return;
    }
    let stderr = '';
    let stdoutTail = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
    child.stdout.on('data', (d) => {
      stdoutTail += d.toString();
      const lines = stdoutTail.split('\n');
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) {
        const p = parseAria2ProgressLine(line);
        if (p && p.done >= lastReported) {
          lastReported = p.done;
          onProgress?.(p.done, p.total ?? expectedSize ?? null);
        }
      }
    });

    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => reject(new Error(`aria2c 启动失败: ${err.message}`)));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) { reject(new Error('已取消')); return; }
      if (code === 0) resolve();
      else reject(new Error(`aria2c 退出码 ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
    });
  });

  const finalSize = await fileSize(destPath);
  if (expectedSize && finalSize !== expectedSize) {
    throw new Error(`aria2c 下载不完整：期望 ${expectedSize} 字节，实际 ${finalSize} 字节`);
  }
  onProgress?.(finalSize, expectedSize ?? finalSize);
  return {
    path: destPath,
    size: finalSize,
    bytes: finalSize,
    engine: 'aria2',
    resumed: preexisting > 0,
  };
}
