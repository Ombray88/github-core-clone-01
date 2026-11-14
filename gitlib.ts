import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export const PKT_FLUSH = 'FLUSH';
export const PKT_DELIM = 'DELIM';
export const PKT_RESPONSE_END = 'RESPONSE_END';

export function hashObjectId(type: string, content: Uint8Array): string {
  const header = `${type} ${content.length}\0`;
  const headerBytes = new TextEncoder().encode(header);
  const hash = createHash('sha1');
  hash.update(headerBytes);
  hash.update(content);
  return hash.digest('hex');
}

export function hashObject(type: string, content: Uint8Array): string {
  return hashObjectId(type, content);
}

export function isObjectId(s: string): boolean {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

export function isValidObjectId(s: string): boolean {
  return isObjectId(s);
}

export function encodePktLine(payload: string | Uint8Array | typeof PKT_FLUSH | typeof PKT_DELIM | typeof PKT_RESPONSE_END): Uint8Array {
  if (payload === PKT_FLUSH) {
    return new TextEncoder().encode('0000');
  }
  if (payload === PKT_DELIM) {
    return new TextEncoder().encode('0001');
  }
  if (payload === PKT_RESPONSE_END) {
    return new TextEncoder().encode('0002');
  }

  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const len = bytes.length + 4;
  if (len > 0xffff) {
    throw new Error('Pkt-line payload too large');
  }
  const hexLen = len.toString(16).padStart(4, '0');
  const header = new TextEncoder().encode(hexLen);
  const result = new Uint8Array(header.length + bytes.length);
  result.set(header, 0);
  result.set(bytes, header.length);
  return result;
}

export function encodePktLines(items: Array<string | Uint8Array | typeof PKT_FLUSH | typeof PKT_DELIM | typeof PKT_RESPONSE_END>): Uint8Array {
  const encoded = items.map(item => encodePktLine(item));
  const totalLength = encoded.reduce((acc, curr) => acc + curr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const enc of encoded) {
    result.set(enc, offset);
    offset += enc.length;
  }
  return result;
}

export interface PktPacket {
  type: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Uint8Array;
  raw: Uint8Array;
}

export class PktLineDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): PktPacket[] {
    const newBuf = new Uint8Array(this.buffer.length + chunk.length);
    newBuf.set(this.buffer, 0);
    newBuf.set(chunk, this.buffer.length);
    this.buffer = newBuf;

    const packets: PktPacket[] = [];
    let pos = 0;

    while (pos + 4 <= this.buffer.length) {
      const headerStr = new TextDecoder().decode(this.buffer.subarray(pos, pos + 4));
      if (headerStr === '0000') {
        const raw = this.buffer.subarray(pos, pos + 4);
        packets.push({ type: 'flush', payload: new Uint8Array(0), raw });
        pos += 4;
        continue;
      }
      if (headerStr === '0001') {
        const raw = this.buffer.subarray(pos, pos + 4);
        packets.push({ type: 'delim', payload: new Uint8Array(0), raw });
        pos += 4;
        continue;
      }
      if (headerStr === '0002') {
        const raw = this.buffer.subarray(pos, pos + 4);
        packets.push({ type: 'response-end', payload: new Uint8Array(0), raw });
        pos += 4;
        continue;
      }

      const len = parseInt(headerStr, 16);
      if (isNaN(len) || len < 4) {
        throw new Error(`Invalid pkt-line header: ${headerStr}`);
      }

      if (pos + len > this.buffer.length) {
        // Incomplete packet, wait for more data
        break;
      }

      const raw = this.buffer.subarray(pos, pos + len);
      const payload = raw.subarray(4);
      packets.push({ type: 'data', payload, raw });
      pos += len;
    }

    this.buffer = this.buffer.subarray(pos);
    return packets;
  }

  finish(): void {
    if (this.buffer.length > 0) {
      throw new Error(`Truncated trailing frame in pkt-line stream (${this.buffer.length} unparsed bytes)`);
    }
  }
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(raw: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const spaceIdx = raw.indexOf(32, pos); // space ASCII 32
    if (spaceIdx === -1) break;
    const mode = new TextDecoder().decode(raw.subarray(pos, spaceIdx));
    
    const nulIdx = raw.indexOf(0, spaceIdx + 1); // NUL ASCII 0
    if (nulIdx === -1) throw new Error('Malformed tree object: missing NUL after filename');
    const name = new TextDecoder().decode(raw.subarray(spaceIdx + 1, nulIdx));

    if (nulIdx + 20 > raw.length) throw new Error('Malformed tree object: truncated object ID');
    const oidBytes = raw.subarray(nulIdx + 1, nulIdx + 21);
    const oid = Buffer.from(oidBytes).toString('hex');

    entries.push({ mode, name, oid });
    pos = nulIdx + 21;
  }
  return entries;
}

function isTreeMode(mode: string): boolean {
  const parsed = parseInt(mode, 8);
  if (!isNaN(parsed)) {
    return (parsed & 0o170000) === 0o040000;
  }
  return mode === '40000' || mode === '040000' || mode.startsWith('4');
}

export function buildTree(entries: Array<{ mode: string | number; name: string; oid: string }>): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    const modeA = String(a.mode);
    const modeB = String(b.mode);
    const nameABytes = new TextEncoder().encode(a.name);
    const nameBBytes = new TextEncoder().encode(b.name);

    const keyA = isTreeMode(modeA) ? appendSlash(nameABytes) : nameABytes;
    const keyB = isTreeMode(modeB) ? appendSlash(nameBBytes) : nameBBytes;

    const minLen = Math.min(keyA.length, keyB.length);
    for (let i = 0; i < minLen; i++) {
      if (keyA[i] !== keyB[i]) {
        return keyA[i] - keyB[i];
      }
    }
    return keyA.length - keyB.length;
  });

  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    const modeStr = String(entry.mode);
    const header = `${modeStr} ${entry.name}\0`;
    const headerBytes = new TextEncoder().encode(header);
    const oidHex = entry.oid;
    if (oidHex.length !== 40) throw new Error(`Invalid oid length: ${oidHex}`);
    const oidBytes = Uint8Array.from(Buffer.from(oidHex, 'hex'));

    const entryBytes = new Uint8Array(headerBytes.length + oidBytes.length);
    entryBytes.set(headerBytes, 0);
    entryBytes.set(oidBytes, headerBytes.length);
    parts.push(entryBytes);
  }

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function appendSlash(bytes: Uint8Array): Uint8Array {
  const res = new Uint8Array(bytes.length + 1);
  res.set(bytes, 0);
  res[bytes.length] = 47; // '/'
  return res;
}

export interface CommitObject {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(raw: Uint8Array): CommitObject {
  const text = new TextDecoder().decode(raw);
  const blankIdx = text.indexOf('\n\n');
  const headerPart = blankIdx === -1 ? text : text.substring(0, blankIdx);
  const message = blankIdx === -1 ? '' : text.substring(blankIdx + 2);

  const lines = headerPart.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';

  for (const line of lines) {
    if (line.startsWith('tree ')) {
      tree = line.substring(5).trim();
    } else if (line.startsWith('parent ')) {
      parents.push(line.substring(7).trim());
    } else if (line.startsWith('author ')) {
      author = line.substring(7);
    } else if (line.startsWith('committer ')) {
      committer = line.substring(10);
    }
  }

  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Uint8Array {
  let content = `tree ${tree}\n`;
  for (const p of parents) {
    content += `parent ${p}\n`;
  }
  content += `author ${author}\n`;
  content += `committer ${committer}\n\n`;
  let cleanMsg = message;
  if (!cleanMsg.endsWith('\n')) {
    cleanMsg += '\n';
  } else if (cleanMsg.endsWith('\n\n')) {
    cleanMsg = cleanMsg.replace(/\n+$/, '\n');
  }
  content += cleanMsg;
  return new TextEncoder().encode(content);
}

export interface TagObject {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(raw: Uint8Array): TagObject {
  const text = new TextDecoder().decode(raw);
  const blankIdx = text.indexOf('\n\n');
  const headerPart = blankIdx === -1 ? text : text.substring(0, blankIdx);
  const message = blankIdx === -1 ? '' : text.substring(blankIdx + 2);

  const lines = headerPart.split('\n');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';

  for (const line of lines) {
    if (line.startsWith('object ')) {
      object = line.substring(7).trim();
    } else if (line.startsWith('type ')) {
      type = line.substring(5).trim();
    } else if (line.startsWith('tag ')) {
      tag = line.substring(4).trim();
    } else if (line.startsWith('tagger ')) {
      tagger = line.substring(7);
    }
  }

  return { object, type, tag, tagger, message };
}

export interface PackObjectInput {
  type: string;
  id: string;
  raw: Uint8Array;
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

function getObjTypeNumber(type: string): number {
  switch (type) {
    case 'commit': return OBJ_COMMIT;
    case 'tree': return OBJ_TREE;
    case 'blob': return OBJ_BLOB;
    case 'tag': return OBJ_TAG;
    default: throw new Error(`Unknown object type for packing: ${type}`);
  }
}

function getTypeName(num: number): string {
  switch (num) {
    case OBJ_COMMIT: return 'commit';
    case OBJ_TREE: return 'tree';
    case OBJ_BLOB: return 'blob';
    case OBJ_TAG: return 'tag';
    default: throw new Error(`Unknown object type number: ${num}`);
  }
}

export function writePack(objects: PackObjectInput[]): Uint8Array {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode('PACK'), 0);
  // Version 2 (big endian uint32)
  header[4] = 0; header[5] = 0; header[6] = 0; header[7] = 2;
  // Object count (big endian uint32)
  const count = objects.length;
  header[8] = (count >>> 24) & 0xff;
  header[9] = (count >>> 16) & 0xff;
  header[10] = (count >>> 8) & 0xff;
  header[11] = count & 0xff;

  const chunks: Uint8Array[] = [header];

  for (const obj of objects) {
    const typeNum = getObjTypeNumber(obj.type);
    const compressed = zlib.deflateSync(obj.raw);

    // Object header (variable length: type in bits 4-6, size in low 4 bits + continuation bytes)
    let size = obj.raw.length;
    const headerBytes: number[] = [];
    let b = ((typeNum & 7) << 4) | (size & 0x0f);
    size >>>= 4;
    while (size > 0) {
      headerBytes.push(b | 0x80);
      b = size & 0x7f;
      size >>>= 7;
    }
    headerBytes.push(b);

    const objHeader = new Uint8Array(headerBytes);
    const entry = new Uint8Array(objHeader.length + compressed.length);
    entry.set(objHeader, 0);
    entry.set(compressed, objHeader.length);

    chunks.push(entry);
  }

  // Calculate total length so far for trailer
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const packWithoutTrailer = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    packWithoutTrailer.set(c, offset);
    offset += c.length;
  }

  const sha1 = createHash('sha1').update(packWithoutTrailer).digest();
  const finalPack = new Uint8Array(packWithoutTrailer.length + 20);
  finalPack.set(packWithoutTrailer, 0);
  finalPack.set(sha1, packWithoutTrailer.length);

  return finalPack;
}

export function verifyPackTrailer(packBytes: Uint8Array): { matches: boolean; expected: string; actual: string } {
  if (packBytes.length < 20) {
    throw new Error('Pack bytes too short for trailer');
  }
  const actualBytes = packBytes.subarray(packBytes.length - 20);
  const actual = Buffer.from(actualBytes).toString('hex');

  const content = packBytes.subarray(0, packBytes.length - 20);
  const expected = createHash('sha1').update(content).digest('hex');

  return {
    matches: expected === actual,
    expected,
    actual,
  };
}

interface ParsedPackEntry {
  entryOffset: number;
  typeNum: number;
  size: number;
  compressedOffset: number;
  compressedLength: number;
  baseOffset?: number;
  baseId?: string;
  deltaData?: Uint8Array;
  raw?: Uint8Array;
}

export function readPack(
  packBytes: Uint8Array,
  lookup?: (id: string) => { type: string; raw: Uint8Array } | undefined
): { objects: Map<string, { type: string; raw: Uint8Array }>; deltaCount: number } {
  if (packBytes.length < 32) {
    throw new Error('Pack bytes too short');
  }

  const magic = new TextDecoder().decode(packBytes.subarray(0, 4));
  if (magic !== 'PACK') {
    throw new Error(`Invalid pack magic: ${magic}`);
  }

  const version = (packBytes[4] << 24) | (packBytes[5] << 16) | (packBytes[6] << 8) | packBytes[7];
  if (version !== 2) {
    throw new Error(`Unsupported pack version: ${version}`);
  }

  const numObjects = (packBytes[8] << 24) | (packBytes[9] << 16) | (packBytes[10] << 8) | packBytes[11];

  let pos = 12;
  const entries: ParsedPackEntry[] = [];

  for (let i = 0; i < numObjects; i++) {
    if (pos >= packBytes.length - 20) {
      throw new Error('Truncated pack file while reading entries');
    }

    const entryOffset = pos;
    let b = packBytes[pos++];
    const typeNum = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      if (pos >= packBytes.length) throw new Error('Truncated pack object header');
      b = packBytes[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }

    let baseOffset: number | undefined;
    let baseId: string | undefined;

    if (typeNum === OBJ_OFS_DELTA) {
      let ofs = 0;
      let c = packBytes[pos++];
      ofs = c & 127;
      while (c & 128) {
        ofs++;
        c = packBytes[pos++];
        ofs = (ofs << 7) + (c & 127);
      }
      baseOffset = entryOffset - ofs;
    } else if (typeNum === OBJ_REF_DELTA) {
      if (pos + 20 > packBytes.length) throw new Error('Truncated ref delta base ID');
      const baseIdBytes = packBytes.subarray(pos, pos + 20);
      baseId = Buffer.from(baseIdBytes).toString('hex');
      pos += 20;
    }

    const compressedOffset = pos;
    const { raw: decompressed, consumed } = inflateWithLength(packBytes, compressedOffset, packBytes.length - 20);
    pos = compressedOffset + consumed;

    if (typeNum === OBJ_OFS_DELTA || typeNum === OBJ_REF_DELTA) {
      entries.push({
        entryOffset,
        typeNum,
        size,
        compressedOffset,
        compressedLength: consumed,
        baseOffset,
        baseId,
        deltaData: decompressed,
      });
    } else {
      const typeName = getTypeName(typeNum);
      entries.push({
        entryOffset,
        typeNum,
        size,
        compressedOffset,
        compressedLength: consumed,
        raw: decompressed,
      });
    }
  }

  // Resolve objects (handling deltas)
  const resolvedObjects = new Map<string, { type: string; raw: Uint8Array }>();
  const offsetToResolved = new Map<number, { type: string; raw: Uint8Array; id: string }>();
  let deltaCount = 0;

  // We may need multiple passes if deltas depend on other deltas that appear later (though git packs are usually topologically sorted, just in case).
  const unresolved = [...entries];
  let maxPasses = unresolved.length + 1;

  while (unresolved.length > 0 && maxPasses-- > 0) {
    const nextUnresolved: ParsedPackEntry[] = [];

    for (const entry of unresolved) {
      if (entry.raw) {
        // Full object
        const typeName = getTypeName(entry.typeNum);
        const id = hashObjectId(typeName, entry.raw);
        const resolvedObj = { type: typeName, raw: entry.raw };
        resolvedObjects.set(id, resolvedObj);
        offsetToResolved.set(entry.entryOffset, { ...resolvedObj, id });
      } else {
        // Delta object
        let baseObj: { type: string; raw: Uint8Array } | undefined;
        let baseType = '';

        if (entry.baseOffset !== undefined) {
          const baseResolved = offsetToResolved.get(entry.baseOffset);
          if (baseResolved) {
            baseObj = baseResolved;
            baseType = baseResolved.type;
          }
        } else if (entry.baseId) {
          if (resolvedObjects.has(entry.baseId)) {
            baseObj = resolvedObjects.get(entry.baseId);
            baseType = baseObj!.type;
          } else if (lookup) {
            baseObj = lookup(entry.baseId);
            if (baseObj) baseType = baseObj.type;
          }
        }

        if (baseObj && entry.deltaData) {
          deltaCount++;
          const targetRaw = applyDelta(baseObj.raw, entry.deltaData);
          const typeName = baseType; // Delta inherits base object type in Git packfiles
          const id = hashObjectId(typeName, targetRaw);
          const resolvedObj = { type: typeName, raw: targetRaw };
          resolvedObjects.set(id, resolvedObj);
          offsetToResolved.set(entry.entryOffset, { ...resolvedObj, id });
        } else {
          nextUnresolved.push(entry);
        }
      }
    }

    if (nextUnresolved.length === unresolved.length) {
      throw new Error('Circular or missing dependency in packfile delta chain');
    }
    unresolved.length = 0;
    unresolved.push(...nextUnresolved);
  }

  if (unresolved.length > 0) {
    throw new Error(`Failed to resolve ${unresolved.length} delta objects in packfile`);
  }

  // Verify every resolved object hashes to its claimed id
  for (const [id, obj] of resolvedObjects.entries()) {
    const computedId = hashObjectId(obj.type, obj.raw);
    if (computedId !== id) {
      throw new Error(`Object hash mismatch: expected ${id}, computed ${computedId}`);
    }
  }

  return { objects: resolvedObjects, deltaCount };
}

function inflateWithLength(buf: Uint8Array, offset: number, maxEnd: number): { raw: Uint8Array; consumed: number } {
  let l = 2;
  let r = maxEnd - offset;
  let bestRaw: Uint8Array | null = null;
  let bestLen = 0;

  // Binary search for zlib stream length
  while (l <= r) {
    const mid = (l + r) >> 1;
    try {
      const decompressed = zlib.inflateSync(buf.subarray(offset, offset + mid));
      bestRaw = decompressed;
      bestLen = mid;
      r = mid - 1; // Try shorter length
    } catch {
      l = mid + 1; // Need more bytes
    }
  }

  if (!bestRaw) {
    throw new Error('Failed to inflate zlib stream in packfile');
  }

  return { raw: bestRaw, consumed: bestLen };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  let srcSize = 0, shift = 0;
  while (pos < delta.length) {
    const b = delta[pos++];
    srcSize |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }

  let tgtSize = 0;
  shift = 0;
  while (pos < delta.length) {
    const b = delta[pos++];
    tgtSize |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }

  if (base.length !== srcSize) {
    // Note: some git implementations permit size mismatch, but let's be careful or allow it.
  }

  const target = new Uint8Array(tgtSize);
  let tgtPos = 0;

  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) {
      let offset = 0, size = 0;
      if (cmd & 0x01) offset = delta[pos++];
      if (cmd & 0x02) offset |= delta[pos++] << 8;
      if (cmd & 0x04) offset |= delta[pos++] << 16;
      if (cmd & 0x08) offset |= delta[pos++] << 24;

      if (cmd & 0x10) size = delta[pos++];
      if (cmd & 0x20) size |= delta[pos++] << 8;
      if (cmd & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;

      if (offset + size > base.length) {
        throw new Error('Delta copy range out of bounds of base object');
      }
      if (tgtPos + size > target.length) {
        throw new Error('Delta copy range out of bounds of target object');
      }

      target.set(base.subarray(offset, offset + size), tgtPos);
      tgtPos += size;
    } else if (cmd > 0) {
      if (pos + cmd > delta.length) {
        throw new Error('Delta insert range out of bounds');
      }
      if (tgtPos + cmd > target.length) {
        throw new Error('Delta insert range out of bounds of target object');
      }
      target.set(delta.subarray(pos, pos + cmd), tgtPos);
      tgtPos += cmd;
      pos += cmd;
    } else {
      throw new Error('Invalid delta opcode 0');
    }
  }

  return target;
}

export function getReachableIds(
  tips: string[],
  lookup: (id: string) => { type: string; raw: Uint8Array } | undefined
): Set<string> {
  const visited = new Set<string>();
  const queue = [...tips];

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    if (!isObjectId(id)) {
      throw new Error(`Invalid object ID encountered during reachability walk: ${id}`);
    }

    const obj = lookup(id);
    if (!obj) {
      throw new Error(`Missing required object ID: ${id}`);
    }

    const computedId = hashObjectId(obj.type, obj.raw);
    if (computedId !== id) {
      throw new Error(`Object hash verification failed for ${id} (computed ${computedId})`);
    }

    visited.add(id);

    if (obj.type === 'commit') {
      const commit = parseCommit(obj.raw);
      if (commit.tree && !visited.has(commit.tree)) {
        queue.push(commit.tree);
      }
      for (const parent of commit.parents) {
        if (parent && !visited.has(parent)) {
          queue.push(parent);
        }
      }
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.raw);
      for (const entry of entries) {
        if (entry.oid && !visited.has(entry.oid)) {
          queue.push(entry.oid);
        }
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.raw);
      if (tag.object && !visited.has(tag.object)) {
        queue.push(tag.object);
      }
    } else if (obj.type === 'blob') {
      // Blobs have no outgoing references
    } else {
      throw new Error(`Unknown object type during reachability walk: ${obj.type}`);
    }
  }

  return visited;
}
