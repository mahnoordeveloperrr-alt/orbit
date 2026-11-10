// ============================================================================
// PACK STORE RELEASE — builds releases/orbitabs-<version>-store.zip from dist/
//
// Why not Compress-Archive: on Windows it writes `assets\popup.js` as the
// entry name, and the ZIP spec (APPNOTE 4.4.17.1) requires forward slashes.
// Chrome Web Store tooling expects spec-compliant names, so this writes the
// archive itself: deflate + CRC32, forward-slash paths, no extra files.
//
// Run: node scripts/pack-store-release.mjs
// ============================================================================

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = resolve(root, 'dist');
const OUT_DIR = resolve(root, 'releases');

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('dist/manifest.json missing — run `npm run build` first.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!version) {
  console.error('dist/manifest.json has no version.');
  process.exit(1);
}

/* ─── CRC32 ───────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ─── collect files (forward-slash relative names) ────────────── */
function collect(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, base, out);
    else out.push({ full, name: full.slice(base.length + 1).split(/[\\/]/).join('/'), mtime: st.mtime });
  }
  return out;
}

const files = collect(DIST);

/* ─── DOS date/time ───────────────────────────────────────────── */
function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/* ─── write archive ───────────────────────────────────────────── */
const localParts = [];
const centralParts = [];
let offset = 0;

for (const file of files) {
  const raw = readFileSync(file.full);
  const deflated = deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);
  const nameBuf = Buffer.from(file.name, 'utf8');
  const { time, date } = dosDateTime(file.mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // local file header signature
  local.writeUInt16LE(20, 4);           // version needed
  local.writeUInt16LE(0, 6);            // flags
  local.writeUInt16LE(method, 8);       // compression method
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);           // extra length

  localParts.push(local, nameBuf, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4);         // version made by
  central.writeUInt16LE(20, 6);         // version needed
  central.writeUInt16LE(0, 8);          // flags
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);         // extra
  central.writeUInt16LE(0, 32);         // comment
  central.writeUInt16LE(0, 34);         // disk start
  central.writeUInt16LE(0, 36);         // internal attrs
  central.writeUInt32LE(0, 38);         // external attrs
  central.writeUInt32LE(offset, 42);    // local header offset

  centralParts.push(central, nameBuf);
  offset += local.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);       // end of central directory
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `orbitabs-${version}-store.zip`);
writeFileSync(outPath, Buffer.concat([...localParts, centralBuf, end]));

const total = statSync(outPath).size;
console.log(`✅ ${outPath}`);
console.log(`   ${files.length} files · ${(total / 1024).toFixed(1)} KB · version ${version}`);
for (const f of files) console.log('   ' + f.name);
