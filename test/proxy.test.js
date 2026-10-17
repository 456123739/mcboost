/**
 * 代理模块测试：URL 编解码、目标解析、PCL 黑名单识别。
 * 这些是"让 PCL 的下载走本地加速"的协议基础，必须可靠。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTarget, resolveTarget, hitsPclBlacklist, PROXY_PORT_DEFAULT } from '../src/proxy.js';

function fakeReq(pathname, host) {
  return { url: pathname, headers: { host } };
}

test('resolveTarget：/d/<base64url> 形式', () => {
  const target = 'https://cdn.modrinth.com/data/AAA/versions/BBB/mod.jar';
  const encoded = Buffer.from(target).toString('base64url');
  const r = resolveTarget(fakeReq(`/d/${encoded}`, '127.0.0.1:8788'), `/d/${encoded}`);
  assert.ok(r);
  assert.equal(r.url, target);
  assert.equal(r.how, 'encoded');
});

test('resolveTarget：/<scheme>/<host>/<path> 形式', () => {
  const r = resolveTarget(fakeReq('/https/cdn.modrinth.com/data/x.jar', '127.0.0.1:8788'), '/https/cdn.modrinth.com/data/x.jar');
  assert.ok(r);
  assert.equal(r.url, 'https://cdn.modrinth.com/data/x.jar');
  assert.equal(r.how, 'scheme');
});

test('resolveTarget：/<scheme>/<host>/ 无路径时补 /', () => {
  const r = resolveTarget(fakeReq('/https/cdn.modrinth.com', '127.0.0.1:8788'), '/https/cdn.modrinth.com');
  assert.equal(r.url, 'https://cdn.modrinth.com/');
});

test('resolveTarget：裸路径 + Host 头', () => {
  const r = resolveTarget(fakeReq('/data/x.jar', 'cdn.modrinth.com'), '/data/x.jar');
  assert.ok(r);
  assert.equal(r.url, 'https://cdn.modrinth.com/data/x.jar');
  assert.equal(r.how, 'host');
});

test('resolveTarget：Host 是本地代理时返回 null（避免自指）', () => {
  assert.equal(resolveTarget(fakeReq('/data/x.jar', '127.0.0.1:8788'), '/data/x.jar'), null);
  assert.equal(resolveTarget(fakeReq('/data/x.jar', 'localhost:8788'), '/data/x.jar'), null);
});

test('resolveTarget：非法 base64 不崩溃', () => {
  const r = resolveTarget(fakeReq('/d/!!!not-base64!!!', '127.0.0.1:8788'), '/d/!!!not-base64!!!');
  // 可能落到 scheme 形式或返回 null，但不能抛异常
  assert.ok(r === null || typeof r.url === 'string');
});

test('encodeTarget / resolveTarget 往返一致', () => {
  const target = 'https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium-fabric-0.5.13%2Bmc1.20.1.jar';
  const encoded = encodeTarget(target);
  const pathOnly = new URL(encoded).pathname;
  const r = resolveTarget(fakeReq(pathOnly, '127.0.0.1:8788'), pathOnly);
  assert.equal(r.url, target, '编码后必须能还原（含 %2B 这类已编码字符）');
});

test('hitsPclBlacklist：识别会让 PCL 退化成单线程的关键词', () => {
  assert.deepEqual(hitsPclBlacklist('https://bmclapi2.bangbang93.com/maven/x.jar'), ['bmclapi']);
  // 注意：raw.githubusercontent.com 里并不包含字面的 "github.com"，
  // 所以不会命中 —— 这也说明 PCL 的黑名单是字面子串匹配。
  assert.deepEqual(hitsPclBlacklist('https://raw.githubusercontent.com/x/y.jar'), []);
  assert.deepEqual(hitsPclBlacklist('https://github.com/x/y.jar'), ['github.com']);
  assert.deepEqual(hitsPclBlacklist('https://cdn.modrinth.com/data/x.jar'), []);
  // 大小写不敏感
  assert.deepEqual(hitsPclBlacklist('https://BMCLAPI2.example.com/x'), ['bmclapi']);
  // 多个关键词同时命中
  assert.deepEqual(hitsPclBlacklist('https://github.com/optifine.net/x').sort(), ['github.com', 'optifine.net'].sort());
});

test('PROXY_PORT 默认值合理', () => {
  assert.equal(typeof PROXY_PORT_DEFAULT, 'number');
  assert.ok(PROXY_PORT_DEFAULT >= 1024 && PROXY_PORT_DEFAULT <= 65535);
});
