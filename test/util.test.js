import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, fmtSpeed, fmtDuration, safeFileName, pool, deepMerge } from '../src/util.js';

test('fmtBytes 覆盖各单位且不越界', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(1024), '1.00 KB');
  assert.equal(fmtBytes(1536), '1.50 KB');
  assert.equal(fmtBytes(1024 * 1024), '1.00 MB');
  assert.equal(fmtBytes(1024 * 1024 * 1.5), '1.50 MB');
  assert.equal(fmtBytes(1024 ** 3), '1.00 GB');
  assert.equal(fmtBytes(1024 ** 4), '1.00 TB');
  // 回归：曾经在 1KB~1MB 区间输出 undefined
  for (const n of [1025, 9999, 100_000, 999_999]) {
    assert.ok(!fmtBytes(n).includes('undefined'), `${n} → ${fmtBytes(n)}`);
  }
  assert.equal(fmtBytes(null), '?');
  assert.equal(fmtBytes(undefined), '?');
});

test('fmtSpeed / fmtDuration', () => {
  assert.match(fmtSpeed(0), /0 B\/s/);
  assert.match(fmtSpeed(2 * 1024 * 1024), /2\.0 MB\/s/);
  assert.equal(fmtDuration(0), '00:00');
  assert.equal(fmtDuration(59), '00:59');
  assert.equal(fmtDuration(60), '01:00');
  assert.equal(fmtDuration(3661), '1:01:01');
});

test('safeFileName 清理非法字符但保留 mod 文件名常见符号', () => {
  assert.equal(safeFileName('sodium-fabric-0.5.13+mc1.20.1.jar'), 'sodium-fabric-0.5.13+mc1.20.1.jar');
  assert.equal(safeFileName('a/b\\c:d*.jar'), 'a_b_c_d_.jar');
  assert.equal(safeFileName('   '), 'unnamed');
  assert.equal(safeFileName('...hidden'), '_hidden');
  assert.equal(safeFileName('中文模组[1.20.1].jar'), '中文模组[1.20.1].jar');
});

test('pool 限制并发数且保序返回', async () => {
  let live = 0, peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const res = await pool(items, 4, async (n) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return n * 2;
  });
  assert.ok(peak <= 4, `峰值并发应 ≤4，实际 ${peak}`);
  assert.deepEqual(res, items.map((n) => n * 2));
});

test('deepMerge 递归合并但数组整体替换', () => {
  const a = { x: 1, nested: { p: 1, q: 2 }, arr: [1, 2] };
  const b = { nested: { q: 9, r: 3 }, arr: [7] };
  const out = deepMerge(a, b);
  assert.equal(out.x, 1);
  assert.deepEqual(out.nested, { p: 1, q: 9, r: 3 });
  assert.deepEqual(out.arr, [7]);
  // 不修改原对象
  assert.deepEqual(a.nested, { p: 1, q: 2 });
});
