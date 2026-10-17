/**
 * aria2 后端测试 —— 重点验证进度解析。
 *
 * 这里刻意覆盖一个真实踩过的坑：aria2 用 --file-allocation=none 时写的是
 * 稀疏文件，落盘 size 会立刻跳到接近文件总长，所以**不能靠轮询文件大小报进度**，
 * 必须解析 aria2 自己输出的进度行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAria2Size, parseAria2ProgressLine, detectAria2 } from '../src/engine/aria.js';

test('parseAria2Size：各种单位', () => {
  assert.equal(parseAria2Size('512B'), 512);
  assert.equal(parseAria2Size('1KiB'), 1024);
  assert.equal(parseAria2Size('1.5MiB'), Math.round(1.5 * 1024 ** 2));
  assert.equal(parseAria2Size('191MiB'), 191 * 1024 ** 2);
  assert.equal(parseAria2Size('2GiB'), 2 * 1024 ** 3);
  assert.equal(parseAria2Size('1MB'), 1000 ** 2);
  assert.equal(parseAria2Size('垃圾输入'), null);
});

test('parseAria2ProgressLine：解析真实进度行', () => {
  const p = parseAria2ProgressLine('[#7f3b2c 12MiB/191MiB(6%) CN:8 DL:6.7MiB ETA:26s]');
  assert.ok(p);
  assert.equal(p.done, 12 * 1024 ** 2);
  assert.equal(p.total, 191 * 1024 ** 2);

  // 没有速度/ETA 字段的形态也要能解析
  const q = parseAria2ProgressLine('[#abc123 0B/1024KiB(0%)]');
  assert.ok(q);
  assert.equal(q.done, 0);
  assert.equal(q.total, 1024 * 1024);

  // 非进度行应返回 null
  assert.equal(parseAria2ProgressLine('Download complete: file.jar'), null);
  assert.equal(parseAria2ProgressLine(''), null);
});

test('detectAria2：能识别本机的 aria2c（没有则跳过）', async () => {
  const info = await detectAria2('aria2c');
  if (info) {
    assert.equal(info.bin, 'aria2c');
    assert.match(info.version, /^[\d.]+$|^unknown$/);
  } else {
    // 环境里没装 aria2c 也属正常，内置引擎是完整实现
    assert.equal(info, null);
  }
});

test('detectAria2：不存在的可执行文件返回 null 而不是抛错', async () => {
  const info = await detectAria2('definitely-not-a-real-binary-xyz');
  assert.equal(info, null);
});
