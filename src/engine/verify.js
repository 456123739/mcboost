/**
 * 文件校验（sha1 / sha512）
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function hashFile(filePath, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    const s = createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('close', () => { /* noop */ });
  });
}

/**
 * 校验文件哈希。hashes 形如 { sha1: '...', sha512: '...' }
 * @returns {{checked:boolean, ok:boolean, algo?:string, expected?:string, actual?:string}}
 */
export async function verifyFile(filePath, hashes) {
  if (!hashes) return { checked: false, ok: true };
  for (const algo of ['sha512', 'sha1', 'md5']) {
    const expected = hashes[algo];
    if (!expected) continue;
    const actual = await hashFile(filePath, algo);
    return {
      checked: true,
      ok: actual.toLowerCase() === String(expected).toLowerCase(),
      algo,
      expected: String(expected).toLowerCase(),
      actual,
    };
  }
  return { checked: false, ok: true };
}
