/**
 * 并发下载队列：大文件优先 + 连接数加权分配。
 *
 * 为什么不能"按列表顺序并发 N 个文件就算了"（实测教训）：
 *
 * 整包 675MB 用 32 文件 × 16 连接下载，总耗时 19 秒。但逐个文件单独测：
 *   rotrBLOCKS 185.9MB  单独下 4.6 秒，整包里却花了 17.4 秒（慢 3.8 倍）
 *   ViaFabricPlus 9.9MB 单独下 0.7 秒，整包里却花了 12.4 秒（慢 17 倍）
 *
 * 原因是**小文件先下完就退出，却不会把连接数让出来**：大文件一直只能拿固定的
 * 16 个连接去和 125 个小文件抢带宽，等小文件全部结束后才慢慢提速 —— 而此时
 * 整个下载的墙钟已经完全被这一个文件决定了（关键路径）。
 *
 * 所以这里做三件事：
 *   1. **大文件优先启动** —— 按文件大小降序取任务，让最慢的文件尽早开始，
 *      它才是墙钟的下限。
 *   2. **连接数按大小加权** —— 大文件拿更多连接（它才是吞吐瓶颈），
 *      小文件拿 1~2 个就够（瓶颈在 RTT 不在带宽）。
 *   3. **让渡** —— 小文件结束后，空闲的连接额度转移给仍在下载的大文件。
 *
 * 第三点是关键：下载过程中活跃文件数从 32 一路掉到 1，
 * 那个唯一的大文件应该能用上全部连接。
 */
import { EventEmitter } from 'node:events';
import { downloadTask } from './download.js';

/** 大文件阈值：超过这个值的文件按"大文件"策略分配连接 */
const BIG_FILE = 16 * 1024 * 1024;

export class DownloadQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.concurrency 同时下载的文件数上限
   * @param {number} [opts.maxConnections] 所有文件连接数总和的上限（用于让渡分配）
   * @param {object} opts.ctx         downloadTask 的上下文
   */
  constructor(opts = {}) {
    super();
    this.concurrency = Math.max(1, opts.concurrency ?? 6);
    this.maxConnections = Math.max(1, opts.maxConnections ?? (opts.ctx?.connections ?? 8) * (opts.concurrency ?? 6));
    this.ctx = opts.ctx ?? {};
    this.stats = { total: 0, done: 0, skipped: 0, failed: 0, bytes: 0, startedAt: 0 };
    this._live = new Map();
  }

  aggregate() {
    let downloaded = 0, total = 0;
    for (const v of this._live.values()) {
      downloaded += v.downloaded;
      total += v.total || 0;
    }
    return { downloaded, total, active: this._live.size };
  }

  /**
   * 按文件大小给每个任务分配连接数。
   *
   * 目标：在"连接数总和受限"的前提下，让大文件多拿、小文件少拿。
   * 小文件的瓶颈是建立连接的 RTT，不是带宽，给它 2 条就够；
   * 大文件的瓶颈是带宽，连接越多越快。
   */
  allocateConnections(tasks, { maxTotal = this.maxConnections, perFileMax = 64 } = {}) {
    const n = Math.max(1, tasks.length);
    const base = Math.max(1, Math.floor(maxTotal / n));
    const out = new Map();

    // 每个文件的基础额度：大文件多给，小文件少给
    const weights = tasks.map((t) => {
      const s = t.size ?? 0;
      if (s >= BIG_FILE) return 4;          // 大文件：值得多连接
      if (s >= 2 * 1024 * 1024) return 2;   // 中等
      return 1;                              // 小文件：1~2 条足够
    });
    const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

    for (let i = 0; i < tasks.length; i++) {
      const share = Math.max(1, Math.round((weights[i] / weightSum) * maxTotal));
      out.set(tasks[i].id, Math.max(1, Math.min(perFileMax, share)));
    }
    // 若总和超了，按权重从大到小削
    let sum = [...out.values()].reduce((a, b) => a + b, 0);
    if (sum > maxTotal) {
      const order = [...out.entries()].sort((a, b) => b[1] - a[1]);
      for (const [id, v] of order) {
        if (sum <= maxTotal) break;
        const cut = Math.min(v - 1, sum - maxTotal);
        if (cut > 0) { out.set(id, v - cut); sum -= cut; }
      }
    }
    return out;
  }

  /**
   * @param {Array} tasks 需含 id / url / dest
   */
  async run(tasks, opts = {}) {
    const { onTaskDone, onTaskFailed } = opts;
    this.stats.total = tasks.length;
    this.stats.startedAt = Date.now();

    // —— 大文件优先：把最大的文件排在最前面启动 ——
    // 关键路径由最慢的文件决定，所以它必须尽早开始，否则墙钟被它一个人拖长。
    const ordered = [...tasks].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    const alloc = this.allocateConnections(ordered);

    let cursor = 0;
    const self = this;
    // 已分配出去的连接数，用于让渡计算
    let usedConnections = 0;
    const active = new Set();

    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= ordered.length) return;
        const task = ordered[i];
        if (self.ctx.signal?.aborted) return;

        // —— 连接让渡 ——
        // 小文件陆陆续续结束，活跃文件数下降。此时仍未完成的大文件
        // 应该拿到更多连接。做法：按当前活跃文件重新分配一次额度。
        let conn = alloc.get(task.id) ?? 2;
        const liveBig = [...active].filter((id) => {
          const t = self._liveMeta?.get(id);
          return t && (t.size ?? 0) >= BIG_FILE;
        });
        if ((task.size ?? 0) >= BIG_FILE) {
          // 大文件：拿满它应得 + 空闲额度
          const free = Math.max(0, self.maxConnections - usedConnections);
          conn = Math.max(conn, Math.min(64, (alloc.get(task.id) ?? 2) + free));
        } else if (liveBig.length > 0 && usedConnections >= self.maxConnections) {
          // 有更大的文件在跑且连接已占满：小文件让路，只给 1 条
          conn = 1;
        }

        active.add(task.id);
        usedConnections += conn;
        this._liveMeta?.set(task.id, task);

        this.emit('task:start', task, { connections: conn });
        const onProgress = (downloaded, total) => {
          self._live.set(task.id, { downloaded, total: total ?? task.size ?? 0 });
          self.emit('progress', task, downloaded, total ?? task.size ?? 0);
        };
        try {
          const result = await downloadTask(task, {
            ...self.ctx,
            connections: conn,
            onProgress,
            onSource: (info) => self.emit('task:source', task, info),
          });
          self._live.delete(task.id);
          active.delete(task.id);
          usedConnections = Math.max(0, usedConnections - conn);
          if (result.status === 'skipped') self.stats.skipped++;
          else { self.stats.done++; self.stats.bytes += result.bytes || 0; }
          this.emit('task:done', task, result);
          onTaskDone?.(task, result);
        } catch (err) {
          self._live.delete(task.id);
          active.delete(task.id);
          usedConnections = Math.max(0, usedConnections - conn);
          if (self.ctx.signal?.aborted) return;
          self.stats.failed++;
          this.emit('task:failed', task, err);
          onTaskFailed?.(task, err);
        }
      }
    };

    this._liveMeta = new Map();
    const n = Math.max(1, Math.min(this.concurrency, tasks.length || 1));
    await Promise.all(new Array(n).fill(0).map(() => worker()));
    this.stats.elapsed = (Date.now() - this.stats.startedAt) / 1000;
    return this.stats;
  }
}
