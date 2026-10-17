/**
 * 终端进度显示：总体进度条 + 活跃文件明细。
 * 非 TTY（重定向到文件）时自动降级为周期性纯文本输出。
 */
import { fmtBytes, fmtSpeed, fmtDuration } from './util.js';

const CLEAR = '\x1b[2K';

function bar(ratio, width = 24, filled = '█', empty = '░') {
  const r = Math.max(0, Math.min(1, ratio || 0));
  const n = Math.round(r * width);
  return filled.repeat(n) + empty.repeat(Math.max(0, width - n));
}

export class ProgressRenderer {
  constructor({ stream = process.stderr, maxActiveLines = 6, intervalMs = 200 } = {}) {
    this.stream = stream;
    this.maxActiveLines = maxActiveLines;
    this.intervalMs = intervalMs;
    this.isTTY = !!stream.isTTY;
    this.startedAt = Date.now();
    this.lastRender = 0;
    this.renderedLines = 0;
    this.totalBytes = 0;
    this.lastBytes = 0;
    this.lastSampleAt = Date.now();
    this.speed = 0;
    this.enabled = true;
    this.active = new Map();
    this.summary = { total: 0, done: 0, skipped: 0, failed: 0 };
    this._writeScheduled = false;
  }

  setSummary(summary) {
    this.summary = { ...this.summary, ...summary };
  }

  /** 更新某个活跃文件的进度 */
  setTask(taskId, { label, downloaded, total }) {
    this.active.set(taskId, { label, downloaded, total });
  }

  removeTask(taskId) {
    this.active.delete(taskId);
  }

  /** 累加已完成的字节（用于总量/速度统计） */
  addBytes(n) {
    this.totalBytes += n;
  }

  setTotalBytesKnown(n) {
    this.knownTotalBytes = n;
  }

  render(force = false) {
    if (!this.enabled) return;
    const now = Date.now();
    if (!force && now - this.lastRender < this.intervalMs) return;
    this.lastRender = now;

    const dt = (now - this.lastSampleAt) / 1000;
    if (dt >= 0.5) {
      const inst = (this.totalBytes - this.lastBytes) / dt;
      // 指数平滑，避免数字乱跳
      this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst;
      this.lastBytes = this.totalBytes;
      this.lastSampleAt = now;
    }

    const elapsed = (now - this.startedAt) / 1000;
    const { total, done, skipped, failed } = this.summary;
    const finished = done + skipped;
    const fileRatio = total ? finished / total : 0;
    const byteRatio = this.knownTotalBytes ? Math.min(1, this.totalBytes / this.knownTotalBytes) : null;

    const eta = (() => {
      if (this.knownTotalBytes && this.speed > 1024) {
        return (this.knownTotalBytes - this.totalBytes) / this.speed;
      }
      if (fileRatio > 0.02 && finished > 0) {
        return (elapsed / fileRatio) * (1 - fileRatio);
      }
      return NaN;
    })();

    if (!this.isTTY) {
      // 非 TTY：每 5 秒打一行摘要
      if (!force && now - (this._lastPlain ?? 0) < 5000) return;
      this._lastPlain = now;
      this.stream.write(
        `[${finished}/${total}] 文件完成 · ${fmtBytes(this.totalBytes)} · ${fmtSpeed(this.speed)} · 用时 ${fmtDuration(elapsed)}\n`
      );
      return;
    }

    const lines = [];
    const pct = (byteRatio ?? fileRatio) * 100;
    lines.push(
      `\x1b[1m mcboost\x1b[0m ${bar(byteRatio ?? fileRatio, 26)} \x1b[1m${pct.toFixed(1)}%\x1b[0m  ` +
      `文件 ${finished}/${total}${failed ? ` \x1b[31m失败 ${failed}\x1b[0m` : ''}  ` +
      `${fmtSpeed(this.speed)}  已用 ${fmtDuration(elapsed)}  剩余 ~${fmtDuration(eta)}`
    );
    if (this.knownTotalBytes) {
      lines.push(`         数据 ${fmtBytes(this.totalBytes)} / ${fmtBytes(this.knownTotalBytes)}`);
    }

    const actives = [...this.active.entries()]
      .sort((a, b) => (b[1].total || 0) - (a[1].total || 0))
      .slice(0, this.maxActiveLines);
    for (const [, t] of actives) {
      const r = t.total ? t.downloaded / t.total : 0;
      const name = (t.label ?? '').length > 38 ? t.label.slice(0, 17) + '…' + t.label.slice(-18) : (t.label ?? '');
      lines.push(`  ${bar(r, 14)} ${String(Math.round(r * 100)).padStart(3)}%  ${name.padEnd(40)} ${fmtBytes(t.downloaded)}${t.total ? `/${fmtBytes(t.total)}` : ''}`);
    }
    if (this.active.size > this.maxActiveLines) {
      lines.push(`  … 另有 ${this.active.size - this.maxActiveLines} 个文件在下载`);
    }

    // 重绘：回到已渲染行数之前，逐行清空重写
    let out = '';
    if (this.renderedLines > 0) out += `\x1b[${this.renderedLines}A`;
    for (let i = 0; i < Math.max(this.renderedLines, lines.length); i++) {
      out += CLEAR + (lines[i] ?? '') + '\n';
    }
    this.renderedLines = lines.length;
    this.stream.write(out);
  }

  /** 在进度区下方打印一行普通日志（不会破坏已渲染的行） */
  log(msg) {
    if (!this.isTTY) { this.stream.write(msg + '\n'); return; }
    if (this.renderedLines > 0) {
      // 清掉当前区块，打印日志，然后把渲染行数归零让下帧重画
      this.stream.write(`\x1b[${this.renderedLines}A`);
      for (let i = 0; i < this.renderedLines; i++) this.stream.write(CLEAR + '\n');
      this.stream.write(`\x1b[${this.renderedLines}A`);
      this.renderedLines = 0;
    }
    this.stream.write(msg + '\n');
  }

  stop() {
    this.enabled = false;
    if (this.isTTY && this.renderedLines > 0) {
      // 保持最后一次进度显示，仅换行收尾
      this.stream.write('\n');
      this.renderedLines = 0;
    }
  }
}
