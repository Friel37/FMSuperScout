// FM27 shortlist-bestanden (.fmf) lezen en schrijven.
// Opbouw: een "afe."-blok met per intern bestand [u32 16][u32 16][AES-128-sleutel][CTR-IV]
// [AES-CTR(zstd(inhoud))], gevolgd door een "fmf."-blok met zstd(index). De index noemt per
// bestand de offset (vanaf het eerste blok), opgeslagen grootte en ruwe grootte.
// Interne bestanden: image.img (leeg), <naam>.slf (speler-UIDs) en _data/details.aom (type,
// naam, FM-gebruikersnaam en versiebytes die we niet duiden en daarom uit een sjabloon nemen).
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const TYPE_HANDLER = 'PLAYER_SHORTLIST_TYPE_HANDLER';
const AFE_MAGIC = Buffer.from('02016166652e080000', 'hex');
const FMF_MAGIC = Buffer.from('0201666d662e080000', 'hex');
const AOM_HEAD = Buffer.from('03016d6f612e0400', 'hex');
const NO_TIME = Buffer.from('00096e88f1ffffff00096e88f1ffffff', 'hex');
const IMG = Buffer.from('01000000000000000000', 'hex');

// Uit een met FM27 (build 26227640) opgeslagen shortlist; alleen gebruikt als er geen eigen
// FM-shortlist als sjabloon in de map staat.
const DEFAULT_TEMPLATE = {
  slfHead: Buffer.from('0301666c732e02000191e72700', 'hex'),
  aomTail: Buffer.concat([Buffer.alloc(10), Buffer.alloc(16, 0xff), lstr('FMSuperScout'),
    Buffer.from('02000100027d228402010010010b6352600b0a946d17', 'hex')]),
};

function lstr(s) {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(4); l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
}
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

function aesCtr(key, iv, data) {
  const c = crypto.createDecipheriv('aes-128-ctr', key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

function parseFmf(buf) {
  if (!buf.subarray(0, 9).equals(AFE_MAGIC)) throw new Error('not an .fmf file');
  const total = Number(buf.readBigUInt64LE(9));
  const base = 9 + Number(buf.readBigUInt64LE(17));
  const afeEnd = 9 + total;
  if (!buf.subarray(afeEnd, afeEnd + 9).equals(FMF_MAGIC)) throw new Error('fmf index missing');
  const man = zlib.zstdDecompressSync(buf.subarray(afeEnd + 9));
  let o = 0;
  const rd32 = () => { const v = man.readUInt32LE(o); o += 4; return v; };
  const rd64 = () => { const v = Number(man.readBigUInt64LE(o)); o += 8; return v; };
  const rdStr = () => { const n = rd32(); const s = man.toString('utf8', o, o + n); o += n; return s; };
  const files = [];
  const readDir = (dir) => {
    const n = rd32();
    for (let i = 0; i < n; i++) {
      const name = rdStr(), ext = rdStr();
      const off = rd64(), stored = rd64(), raw = rd64();
      o += 16;
      const blk = buf.subarray(base + off, base + off + stored);
      const kl = blk.readUInt32LE(0), il = blk.readUInt32LE(4);
      const data = zlib.zstdDecompressSync(aesCtr(blk.subarray(8, 8 + kl), blk.subarray(8 + kl, 8 + kl + il), blk.subarray(8 + kl + il)));
      if (data.length !== raw) throw new Error('size mismatch in ' + name + ext);
      files.push({ path: (dir ? dir + '/' : '') + name + ext, ext, data });
    }
    const nd = rd32();
    for (let i = 0; i < nd; i++) readDir((dir ? dir + '/' : '') + rdStr());
  };
  const name = rdStr();
  readDir('');
  return { name, files };
}

// Leest naam + UIDs uit een player-shortlist, plus de sjabloondelen rond de naam.
function readShortlist(buf) {
  const { files } = parseFmf(buf);
  const aom = files.find(f => f.ext === '.aom')?.data;
  const slf = files.find(f => f.ext === '.slf')?.data;
  if (!aom || !slf || !aom.subarray(0, AOM_HEAD.length).equals(AOM_HEAD)) throw new Error('not a shortlist');
  let o = AOM_HEAD.length;
  const tl = aom.readUInt32LE(o); const type = aom.toString('utf8', o + 4, o + 4 + tl); o += 4 + tl;
  if (type !== TYPE_HANDLER) throw new Error('not a player shortlist');
  const nl = aom.readUInt32LE(o); o += 4 + nl;
  const aomTail = aom.subarray(o);
  if (slf.toString('latin1', 2, 6) !== 'fls.') throw new Error('bad .slf');
  const headLen = 13;
  const sl = slf.readUInt32LE(headLen);
  const name = slf.toString('utf8', headLen + 4, headLen + 4 + sl);
  let p = headLen + 4 + sl;
  const count = slf.readUInt32LE(p); p += 4;
  const ids = [];
  for (let i = 0; i < count; i++, p += 4) ids.push(slf.readUInt32LE(p));
  return { name, ids, template: { slfHead: slf.subarray(0, headLen), aomTail } };
}

function encBlock(data) {
  const key = crypto.randomBytes(16), iv = crypto.randomBytes(16);
  return Buffer.concat([u32(16), u32(16), key, iv, aesCtr(key, iv, zlib.zstdCompressSync(data))]);
}

function buildShortlist(name, ids, template = DEFAULT_TEMPLATE) {
  const content = {
    details: Buffer.concat([AOM_HEAD, lstr(TYPE_HANDLER), lstr(name), template.aomTail]),
    image: IMG,
    slf: Buffer.concat([template.slfHead, lstr(name), u32(ids.length), ...ids.map(u32), Buffer.from([0])]),
  };
  const order = ['details', 'image', 'slf'];
  const blocks = {}, offs = {};
  let off = 0;
  for (const k of order) { blocks[k] = encBlock(content[k]); offs[k] = off; off += blocks[k].length; }
  const entry = (n, ext, k) => Buffer.concat([lstr(n), lstr(ext), u64(offs[k]), u64(blocks[k].length), u64(content[k].length), NO_TIME]);
  const index = Buffer.concat([lstr(name),
    u32(2), entry('image', '.img', 'image'), entry(name, '.slf', 'slf'),
    u32(1), lstr('_data'), u32(1), entry('details', '.aom', 'details'), u32(0)]);
  const body = Buffer.concat(order.map(k => blocks[k]));
  return Buffer.concat([AFE_MAGIC, u64(17 + body.length), u64(17), Buffer.from([order.length]), body,
    FMF_MAGIC, zlib.zstdCompressSync(index)]);
}

module.exports = { parseFmf, readShortlist, buildShortlist, DEFAULT_TEMPLATE };
