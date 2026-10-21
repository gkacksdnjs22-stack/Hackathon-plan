import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';
import { PUBLIC_FILES } from './public-assets.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(ROOT, 'cloudflare-upload');
const ARCHIVE = path.join(ROOT, '..', '길-Cloudflare-사진-투명.zip');
const files = new Map();

// Deliberately copy an explicit public allowlist; never enumerate the project or .env.
for (const filename of PUBLIC_FILES.keys()) files.set(filename, await readFile(path.join(ROOT, filename)));
const compiled = await build({ entryPoints: [path.join(ROOT, 'cloudflare-worker.mjs')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, sourcemap: false, metafile: true, legalComments: 'none' });
if (compiled.metafile.outputs[Object.keys(compiled.metafile.outputs)[0]].imports.length) throw new Error('Worker must be a self-contained module.');
const worker = compiled.outputFiles[0].contents;
if (/\b(?:Buffer|process)\b|(?:from\s*|import\s*)['"]node:/.test(new TextDecoder().decode(worker))) throw new Error('Unexpected Node runtime dependency.');
files.set('_worker.js', worker);
files.set('_routes.json', Buffer.from(JSON.stringify({ version: 1, include: ['/*'], exclude: [] }, null, 2)));

const crcTable = Array.from({ length: 256 }, (_, initial) => {
  let number = initial;
  for (let bit = 0; bit < 8; bit++) number = number & 1 ? 0xedb88320 ^ (number >>> 1) : number >>> 1;
  return number >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, bytes] of entries) {
    const name = Buffer.from(filename), data = Buffer.from(bytes), compressed = deflateRawSync(data), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    // A fixed valid timestamp makes identical builds reproducible.
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

await mkdir(OUTPUT, { recursive: true });
for (const [filename, bytes] of files) await writeFile(path.join(OUTPUT, filename), bytes);
await writeFile(ARCHIVE, zip(files));
console.log(`Cloudflare ZIP: ${ARCHIVE}`);
console.log(`Public files: ${files.size}; API worker bundled; no environment files included.`);
