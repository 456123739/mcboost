/**
 * ZIP 读取器测试 —— 用系统 zip 命令生成真实压缩包来验证，
 * 覆盖 stored / deflate / 目录条目 / 中文文件名 / 子目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listZip, readZipFile, readZipEntry, extractZip } from '../src/packs/zip.js';
import { detectPackType } from '../src/packs/modrinth.js';
import { safeJoinPath } from '../src/util.js';

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcboost-zip-'));
}

function buildZip(dir, files, { store = false } = {}) {
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(src, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const zipPath = path.join(dir, store ? 'store.zip' : 'deflate.zip');
  const args = ['-r', '-q', zipPath, '.'];
  if (store) args.splice(1, 0, '-0');
  execFileSync('zip', args, { cwd: src });
  return fs.readFileSync(zipPath);
}

test('列出并读取 deflate 压缩的条目', () => {
  const dir = mktmp();
  const buf = buildZip(dir, {
    'manifest.json': JSON.stringify({ name: '测试包', files: [{ projectID: 1, fileID: 2 }] }),
    'mods/example.jar': 'not really a jar',
    'README.txt': 'hello',
  });
  const names = listZip(buf).map((e) => e.name).sort();
  assert.ok(names.includes('manifest.json'), `条目应含 manifest.json，实际: ${names}`);
  assert.ok(names.includes('mods/example.jar'));

  const manifest = JSON.parse(readZipFile(buf, 'manifest.json').toString('utf8'));
  assert.equal(manifest.name, '测试包');
  assert.equal(manifest.files[0].fileID, 2);

  const jar = readZipFile(buf, 'mods/example.jar').toString('utf8');
  assert.equal(jar, 'not really a jar');
});

test('列出并读取 stored（不压缩）的条目', () => {
  const dir = mktmp();
  const buf = buildZip(dir, { 'a.txt': 'A'.repeat(5000) }, { store: true });
  const entries = listZip(buf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, 0, 'stored 模式的压缩方式应为 0');
  assert.equal(readZipEntry(buf, entries[0]).length, 5000);
});

test('读取子目录与中文文件名', () => {
  const dir = mktmp();
  const buf = buildZip(dir, { '配置/说明.txt': '中文内容', 'deep/nested/dir/f.bin': 'x' });
  const txt = readZipFile(buf, '配置/说明.txt');
  assert.ok(txt, '应能按中文路径读取');
  assert.equal(txt.toString('utf8'), '中文内容');
  assert.ok(readZipFile(buf, 'deep/nested/dir/f.bin'));
});

test('不存在的条目返回 null', () => {
  const dir = mktmp();
  const buf = buildZip(dir, { 'a.txt': 'a' });
  assert.equal(readZipFile(buf, 'nope.txt'), null);
});

test('无损解压到目录', async () => {
  const dir = mktmp();
  const buf = buildZip(dir, {
    'overrides/config/settings.toml': 'key = 1',
    'overrides/mods/keep.jar': 'JARDATA',
    'other/ignore.txt': 'no',
  });
  const out = path.join(dir, 'out');
  const res = await extractZip(buf, out, { stripPrefix: 'overrides/' });
  assert.equal(res.written, 2, '只应解出 overrides/ 下的 2 个文件');
  assert.equal(fs.readFileSync(path.join(out, 'config/settings.toml'), 'utf8'), 'key = 1');
  assert.equal(fs.readFileSync(path.join(out, 'mods/keep.jar'), 'utf8'), 'JARDATA');
  assert.equal(fs.existsSync(path.join(out, 'other/ignore.txt')), false);
});

test('识别 mrpack 与 curseforge 整合包', () => {
  const dir = mktmp();
  const mrpack = buildZip(dir, {
    'modrinth.index.json': JSON.stringify({ formatVersion: 1, files: [] }),
    'overrides/config/a.txt': 'x',
  });
  assert.equal(detectPackType(mrpack).type, 'modrinth');

  const dir2 = mktmp();
  const cf = buildZip(dir2, { 'manifest.json': JSON.stringify({ minecraft: {} }), 'overrides/x': 'y' });
  assert.equal(detectPackType(cf).type, 'curseforge');

  const dir3 = mktmp();
  const junk = buildZip(dir3, { 'random.txt': 'x' });
  assert.equal(detectPackType(junk).type, 'unknown');
});

test('拒绝非 ZIP 数据', () => {
  assert.throws(() => listZip(Buffer.from('this is definitely not a zip file at all!!')), /ZIP/);
});

test('safeJoinPath 阻止路径穿越', () => {
  const root = '/tmp/mcboost-instance';
  assert.equal(safeJoinPath(root, 'mods/a.jar'), path.join(root, 'mods/a.jar'));
  assert.equal(safeJoinPath(root, '/leading/slash.txt'), path.join(root, 'leading/slash.txt'));
  assert.throws(() => safeJoinPath(root, '../../etc/passwd'), /不安全/);
  assert.throws(() => safeJoinPath(root, 'a/../../../../etc/passwd'), /不安全/);
});
