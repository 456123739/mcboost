/**
 * 极简 ZIP 读取/解压器（零依赖）。
 *
 * Node 没有内置 zip 支持，而整合包（.mrpack / CurseForge zip）都是 zip 容器。
 * 这里只实现读取所需的最小集合：中央目录解析 + stored/deflate 两种压缩方式，
 * 并支持 ZIP64 的基本情形。不解压全部内容时（只读 manifest）成本极低。
 */
import zlib from 'node:zlib';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeJoinPath } from '../util.js';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipError extends Error {
  constructor(msg) { super(msg); this.name = 'ZipError'; }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError('不是有效的 ZIP 文件（找不到中央目录结束标记）');
}

/**
 * 列出 zip 内所有条目
 * @param {Buffer} buf
 */
export function listZip(buf) {
  if (buf.length < 22) throw new ZipError('文件太小，不是有效的 ZIP');
  const eocd = findEocd(buf);
  let total = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64 处理
  if (total === 0xffff || cdOffset === 0xffffffff) {
    const locOff = eocd - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === SIG_EOCD64_LOCATOR) {
      const eocd64 = Number(buf.readBigUInt64LE(locOff + 8));
      if (eocd64 >= 0 && buf.readUInt32LE(eocd64) === SIG_EOCD64) {
        total = Number(buf.readBigUInt64LE(eocd64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // ZIP64 扩展字段
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const hid = buf.readUInt16LE(ep);
        const hsz = buf.readUInt16LE(ep + 2);
        if (hid === 0x0001) {
          let fp = ep + 4;
          const lim = ep + 4 + hsz;
          if (uncompSize === 0xffffffff && fp + 8 <= lim) { uncompSize = Number(buf.readBigUInt64LE(fp)); fp += 8; }
          if (compSize === 0xffffffff && fp + 8 <= lim) { compSize = Number(buf.readBigUInt64LE(fp)); fp += 8; }
          if (localOffset === 0xffffffff && fp + 8 <= lim) { localOffset = Number(buf.readBigUInt64LE(fp)); fp += 8; }
          break;
        }
        ep += 4 + hsz;
      }
    }

    entries.push({
      name,
      method,
      flags,
      compSize,
      uncompSize,
      localOffset,
      isDirectory: name.endsWith('/'),
      encrypted: (flags & 0x1) === 1,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解出单个条目的原始内容 */
export function readZipEntry(buf, entry) {
  if (entry.encrypted) throw new ZipError(`条目已加密，无法读取: ${entry.name}`);
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== SIG_LOCAL) throw new ZipError(`本地文件头损坏: ${entry.name}`);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(data);
    } catch (err) {
      throw new ZipError(`解压失败 ${entry.name}: ${err.message}`);
    }
  }
  throw new ZipError(`不支持的压缩方式 ${entry.method}（${entry.name}）`);
}

/** 按名字读取一个条目（找不到返回 null） */
export function readZipFile(buf, name) {
  const target = name.replace(/^\/+/, '');
  const entries = listZip(buf);
  const entry = entries.find((e) => e.name === target)
    ?? entries.find((e) => e.name.replace(/^\/+/, '') === target)
    ?? entries.find((e) => e.name.toLowerCase() === target.toLowerCase());
  if (!entry || entry.isDirectory) return null;
  return readZipEntry(buf, entry);
}

/**
 * 解压全部（或按 filter 选择）条目到目录。
 * @param {Buffer} buf
 * @param {string} destDir
 * @param {object} [opts]
 * @param {function} [opts.filter]  (entry) => boolean
 * @param {string}   [opts.stripPrefix] 需要剥离的前缀（如 'overrides/'）
 * @param {boolean}  [opts.overwrite=true]
 */
export async function extractZip(buf, destDir, opts = {}) {
  const { filter, stripPrefix = '', overwrite = true } = opts;
  const entries = listZip(buf);
  let written = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (stripPrefix && !entry.name.startsWith(stripPrefix)) continue;
    const rel = stripPrefix ? entry.name.slice(stripPrefix.length) : entry.name;
    if (!rel) continue;
    if (filter && !filter(entry, rel)) continue;
    const target = safeJoinPath(destDir, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (!overwrite) {
      const exists = await fsp.stat(target).then(() => true, () => false);
      if (exists) continue;
    }
    const content = readZipEntry(buf, entry);
    await fsp.writeFile(target, content);
    written++;
  }
  return { written };
}
