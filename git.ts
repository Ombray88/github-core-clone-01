import type { Store } from './store.ts';
import {
  isAuthenticated,
  viewerLogin,
  getRepository,
  listRefs,
  resolveRef,
  getObject,
  putObject,
  setRef,
  deleteRef,
  isAncestor,
  walkReachability,
} from './store.ts';
import { encodePktLine, PKT_FLUSH, PKT_DELIM, parseTag, readPack, PktLineDecoder, parseCommit, parseTree, writePack, type PackObjectInput } from './gitlib.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * Generate a standardized JSON error response with HTTP headers and request ID.
 */
function sendJsonError(status: number, message: string): { status: number; headers: Record<string, string>; body: string } {
  const jsonBody = JSON.stringify({ message }) + '\n';
  return {
    status,
    headers: {
      'content-type': JSON_TYPE,
      'content-length': String(Buffer.byteLength(jsonBody)),
    },
    body: jsonBody,
  };
}

/**
 * Verify if a given string is a valid non-zero 40-character hexadecimal git object ID.
 */
function isValidOid(oid: string | null | undefined): oid is string {
  return typeof oid === 'string' && /^[0-9a-f]{40}$/.test(oid) && oid !== '0000000000000000000000000000000000000000';
}

/**
 * Handle smart-HTTP git requests for info/refs discovery endpoints.
 */
export function handleGitRequest(
  store: Store,
  owner: string,
  repoName: string,
  serviceName: string,
  headers: Readonly<Record<string, string>>,
  query: Readonly<Record<string, string>>
): { status: number; headers: Record<string, string>; body: Uint8Array | string } {
  // Extract authorization header case-insensitively
  let authHeader: string | undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      authHeader = v;
      break;
    }
  }

  if (!isAuthenticated(authHeader)) {
    return sendJsonError(401, 'Requires authentication');
  }

  // Verify repository ownership and existence
  if (owner !== viewerLogin) {
    return sendJsonError(404, 'Not Found');
  }

  const repo = getRepository(store, owner, repoName);
  if (!repo) {
    return sendJsonError(404, 'Not Found');
  }

  // Validate supported git service names
  if (serviceName !== 'git-upload-pack' && serviceName !== 'git-receive-pack') {
    return sendJsonError(404, 'Not Found');
  }

  // Detect Git protocol version 2 headers for upload-pack
  let gitProtocol: string | undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'git-protocol') {
      gitProtocol = v;
      break;
    }
  }

  const isV2 = serviceName === 'git-upload-pack' && gitProtocol && gitProtocol.includes('version=2');

  const contentType = serviceName === 'git-upload-pack'
    ? 'application/x-git-upload-pack-advertisement'
    : 'application/x-git-receive-pack-advertisement';

  const chunks: Uint8Array[] = [];

  if (isV2) {
    // Construct protocol version 2 advertisement packet lines
    chunks.push(encodePktLine('version 2\n'));
    chunks.push(encodePktLine('ls-refs\n'));
    chunks.push(encodePktLine('fetch=shallow ofs-delta thin-pack\n'));
    chunks.push(encodePktLine('object-format=sha1\n'));
    chunks.push(encodePktLine(PKT_FLUSH));
  } else {
    // Construct protocol version 0 advertisement packet lines
    chunks.push(encodePktLine(`# service=${serviceName}\n`));
    chunks.push(encodePktLine(PKT_FLUSH));

    const refs = listRefs(store, repo);
    const defaultBranchRef = `refs/heads/${repo.defaultBranch}`;

    let headTip = '0000000000000000000000000000000000000000';
    const resolvedHead = resolveRef(store, repo, 'HEAD');
    if (resolvedHead) {
      headTip = resolvedHead;
    } else {
      const defaultResolved = resolveRef(store, repo, defaultBranchRef);
      if (defaultResolved) {
        headTip = defaultResolved;
      }
    }

    if (refs.length === 0) {
      const caps = serviceName === 'git-upload-pack'
        ? 'side-band-64k multi_ack thin-pack ofs-delta shallow agent'
        : 'report-status side-band-64k delete-refs ofs-delta agent';
      const line = `0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`;
      chunks.push(encodePktLine(line));
    } else {
      let caps = '';
      if (serviceName === 'git-upload-pack') {
        caps = `side-band-64k multi_ack thin-pack ofs-delta shallow agent symref=HEAD:${defaultBranchRef}`;
      } else {
        caps = 'report-status side-band-64k delete-refs ofs-delta agent';
      }

      const firstLineText = `${headTip} HEAD\0${caps}\n`;
      chunks.push(encodePktLine(firstLineText));

      for (const r of refs) {
        const refLine = `${r.oid} ${r.name}\n`;
        chunks.push(encodePktLine(refLine));
      }

      for (const r of refs) {
        if (r.name.startsWith('refs/tags/')) {
          const obj = getObject(store, r.oid);
          if (obj && obj.type === 'tag') {
            try {
              const tagObj = parseTag(obj.raw);
              if (isValidOid(tagObj.object)) {
                const peeledLine = `${tagObj.object} ${r.name}^{}\n`;
                chunks.push(encodePktLine(peeledLine));
              }
            } catch {}
          }
        }
      }
    }

    chunks.push(encodePktLine(PKT_FLUSH));
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const bodyBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    bodyBytes.set(c, offset);
    offset += c.length;
  }

  return {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(bodyBytes.length),
      'cache-control': 'no-cache',
    },
    body: bodyBytes,
  };
}

/**
 * Handle git-upload-pack POST requests (Protocol v2 ls-refs).
 */
class PackCache {
  #maxSize: number;
  #map: Map<string, Uint8Array>;

  constructor(maxSize = 32) {
    this.#maxSize = maxSize;
    this.#map = new Map();
  }

  get(key: string): Uint8Array | undefined {
    return this.#map.get(key);
  }

  set(key: string, value: Uint8Array): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#maxSize) {
      const oldestKey = this.#map.keys().next().value;
      if (oldestKey !== undefined) {
        this.#map.delete(oldestKey);
      }
    }
    this.#map.set(key, value);
  }
}

const packCache = new PackCache(64);

export function handleGitUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer | null
): { status: number; headers: Record<string, string>; body: Uint8Array | string } {
  let authHeader: string | undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      authHeader = v;
      break;
    }
  }

  if (!isAuthenticated(authHeader)) {
    return sendJsonError(401, 'Requires authentication');
  }

  if (owner !== viewerLogin) {
    return sendJsonError(404, 'Not Found');
  }

  const repo = getRepository(store, owner, repoName);
  if (!repo) {
    return sendJsonError(404, 'Not Found');
  }

  if (!body || body.length === 0) {
    return sendJsonError(400, 'Bad request body');
  }

  let packets;
  try {
    const decoder = new PktLineDecoder();
    packets = decoder.feed(body);
    decoder.finish();
  } catch {
    return sendJsonError(400, 'Malformed upload-pack body');
  }

  let command = '';
  let peel = false;
  let symrefs = false;
  const refPrefixes: string[] = [];

  let i = 0;
  while (i < packets.length && packets[i].type !== 'delim' && packets[i].type !== 'flush') {
    const pkt = packets[i];
    if (pkt.type === 'data') {
      let text = new TextDecoder().decode(pkt.payload);
      if (text.endsWith('\n')) text = text.substring(0, text.length - 1);
      if (text.startsWith('command=')) {
        command = text.substring(8).trim();
      }
    }
    i++;
  }

  if (!command) {
    return sendJsonError(400, 'No command specified');
  }

  if (command !== 'ls-refs' && command !== 'fetch') {
    return sendJsonError(404, 'Not Found');
  }

  if (command === 'fetch') {
    if (i < packets.length && packets[i].type === 'delim') {
      i++;
    }

    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallows = new Set<string>();
    let deepen: number | null = null;

    while (i < packets.length && packets[i].type !== 'flush') {
      const pkt = packets[i];
      if (pkt.type === 'data') {
        let text = new TextDecoder().decode(pkt.payload);
        if (text.endsWith('\n')) text = text.substring(0, text.length - 1);
        if (text.startsWith('want ')) {
          const parts = text.substring(5).trim().split(/\s+/);
          for (const p of parts) {
            if (isValidOid(p)) wants.push(p);
          }
        } else if (text.startsWith('have ')) {
          const parts = text.substring(5).trim().split(/\s+/);
          for (const p of parts) {
            if (isValidOid(p)) haves.push(p);
          }
        } else if (text.startsWith('shallow ')) {
          const parts = text.substring(8).trim().split(/\s+/);
          for (const p of parts) {
            if (isValidOid(p)) clientShallows.add(p);
          }
        } else if (text.startsWith('deepen ')) {
          const val = parseInt(text.substring(7).trim(), 10);
          if (!isNaN(val)) deepen = val;
        }
      }
      i++;
    }

    const cacheKey = [
      owner,
      repoName,
      String(store.version ?? 0),
      `wants:${wants.slice().sort().join(',')}`,
      `haves:${haves.slice().sort().join(',')}`,
      `deepen:${deepen ?? ''}`,
      `shallows:${Array.from(clientShallows).sort().join(',')}`
    ].join('|');

    const cachedBody = packCache.get(cacheKey);
    if (cachedBody) {
      return {
        status: 200,
        headers: {
          'content-type': 'application/x-git-upload-pack-result',
          'content-length': String(cachedBody.length),
          'cache-control': 'no-cache',
        },
        body: cachedBody
      };
    }

    const cutParents = new Set<string>();
    const includedObjectIds = new Set<string>();
    const includedCommits = new Set<string>();

    function collectTree(treeId: string) {
      if (!isValidOid(treeId)) return;
      if (includedObjectIds.has(treeId)) return;
      const obj = getObject(store, treeId);
      if (!obj || obj.type !== 'tree') return;
      includedObjectIds.add(treeId);
      try {
        const entries = parseTree(obj.raw);
        for (const entry of entries) {
          if (isValidOid(entry.oid)) {
            const childObj = getObject(store, entry.oid);
            if (childObj) {
              if (childObj.type === 'tree') {
                collectTree(entry.oid);
              } else {
                includedObjectIds.add(entry.oid);
              }
            }
          }
        }
      } catch {}
    }

    const missingWant = wants.some(w => getObject(store, w) === null);
    if (!missingWant && wants.length > 0) {
      const commitQueue: Array<[string, number]> = [];
      const plainCommitQueue: string[] = [];

      for (const w of wants) {
        let currentId = w;
        let curObj = getObject(store, currentId);
        while (curObj && curObj.type === 'tag') {
          includedObjectIds.add(currentId);
          try {
            const tagObj = parseTag(curObj.raw);
            if (isValidOid(tagObj.object)) {
              currentId = tagObj.object;
              curObj = getObject(store, currentId);
            } else {
              break;
            }
          } catch {
            break;
          }
        }

        if (!curObj) continue;
        if (curObj.type === 'commit') {
          if (deepen !== null) {
            commitQueue.push([currentId, 0]);
          } else {
            plainCommitQueue.push(currentId);
          }
        } else if (curObj.type === 'tree') {
          collectTree(currentId);
        } else if (curObj.type === 'blob') {
          includedObjectIds.add(currentId);
        }
      }

      if (deepen !== null) {
        const maxDist = deepen - 1;
        while (commitQueue.length > 0) {
          const [cid, dist] = commitQueue.shift()!;
          if (includedCommits.has(cid)) continue;
          const cObj = getObject(store, cid);
          if (!cObj || cObj.type !== 'commit') continue;
          includedCommits.add(cid);
          includedObjectIds.add(cid);
          try {
            const commitData = parseCommit(cObj.raw);
            if (dist < maxDist) {
              for (const p of commitData.parents) {
                if (isValidOid(p)) {
                  commitQueue.push([p, dist + 1]);
                }
              }
            } else {
              for (const p of commitData.parents) {
                if (isValidOid(p)) {
                  cutParents.add(p);
                }
              }
            }
          } catch {}
        }
      } else {
        const visited = new Set<string>();
        while (plainCommitQueue.length > 0) {
          const cid = plainCommitQueue.pop()!;
          if (visited.has(cid)) continue;
          visited.add(cid);
          const cObj = getObject(store, cid);
          if (!cObj || cObj.type !== 'commit') continue;
          includedCommits.add(cid);
          includedObjectIds.add(cid);
          try {
            const commitData = parseCommit(cObj.raw);
            if (clientShallows.has(cid)) {
              for (const p of commitData.parents) {
                if (isValidOid(p)) {
                  cutParents.add(p);
                }
              }
            } else {
              for (const p of commitData.parents) {
                if (isValidOid(p)) {
                  plainCommitQueue.push(p);
                }
              }
            }
          } catch {}
        }
      }

      for (const cid of includedCommits) {
        const cObj = getObject(store, cid);
        if (cObj && cObj.type === 'commit') {
          try {
            const commitData = parseCommit(cObj.raw);
            if (isValidOid(commitData.tree)) {
              collectTree(commitData.tree);
            }
          } catch {}
        }
      }

      const validHaves = haves.filter(h => getObject(store, h) !== null);
      if (validHaves.length > 0) {
        const excludeObjectIds = new Set<string>();
        const excludeCommits = new Set<string>();

        function collectExcludeTree(treeId: string) {
          if (!isValidOid(treeId)) return;
          if (excludeObjectIds.has(treeId)) return;
          const obj = getObject(store, treeId);
          if (!obj || obj.type !== 'tree') return;
          excludeObjectIds.add(treeId);
          try {
            const entries = parseTree(obj.raw);
            for (const entry of entries) {
              if (isValidOid(entry.oid)) {
                const childObj = getObject(store, entry.oid);
                if (childObj) {
                  if (childObj.type === 'tree') {
                    collectExcludeTree(entry.oid);
                  } else {
                    excludeObjectIds.add(entry.oid);
                  }
                }
              }
            }
          } catch {}
        }

        const haveQueue: string[] = [];
        for (const h of validHaves) {
          if (isValidOid(h)) {
            haveQueue.push(h);
          }
        }

        const visitedHave = new Set<string>();
        while (haveQueue.length > 0) {
          const hid = haveQueue.pop()!;
          if (visitedHave.has(hid)) continue;
          visitedHave.add(hid);

          const obj = getObject(store, hid);
          if (!obj) continue;

          if (obj.type === 'tag') {
            excludeObjectIds.add(hid);
            try {
              const tagObj = parseTag(obj.raw);
              if (isValidOid(tagObj.object)) {
                haveQueue.push(tagObj.object);
              }
            } catch {}
          } else if (obj.type === 'commit') {
            excludeObjectIds.add(hid);
            excludeCommits.add(hid);
            try {
              const commitData = parseCommit(obj.raw);
              if (isValidOid(commitData.tree)) {
                collectExcludeTree(commitData.tree);
              }
              if (!clientShallows.has(hid)) {
                for (const p of commitData.parents) {
                  if (isValidOid(p)) {
                    haveQueue.push(p);
                  }
                }
              }
            } catch {}
          } else if (obj.type === 'tree') {
            collectExcludeTree(hid);
          } else if (obj.type === 'blob') {
            excludeObjectIds.add(hid);
          }
        }

        for (const id of excludeObjectIds) {
          includedObjectIds.delete(id);
        }
        for (const cid of excludeCommits) {
          includedCommits.delete(cid);
        }
      }
    }

    const replyShallow: string[] = [];
    const replyUnshallow: string[] = [];

    for (const cid of includedCommits) {
      const cObj = getObject(store, cid);
      if (cObj && cObj.type === 'commit') {
        try {
          const commitData = parseCommit(cObj.raw);
          const hasCutParent = commitData.parents.some(p => cutParents.has(p));
          if (hasCutParent) {
            replyShallow.push(cid);
          }
        } catch {}
      }
    }

    for (const s of clientShallows) {
      if (includedObjectIds.has(s)) {
        const sObj = getObject(store, s);
        if (sObj && sObj.type === 'commit') {
          try {
            const commitData = parseCommit(sObj.raw);
            const allParentsIncluded = commitData.parents.every(p => includedObjectIds.has(p));
            if (allParentsIncluded) {
              replyUnshallow.push(s);
            }
          } catch {}
        }
      }
    }

    const sections: Array<Array<string | Uint8Array>> = [];

    if (haves.length > 0) {
      const ackSection: Array<string | Uint8Array> = ['acknowledgments\n'];
      const validHaves = haves.filter(h => getObject(store, h) !== null);
      if (validHaves.length > 0) {
        const seenHaves = new Set<string>();
        for (const h of haves) {
          if (!seenHaves.has(h) && getObject(store, h) !== null) {
            seenHaves.add(h);
            ackSection.push(`ACK ${h}\n`);
          }
        }
        ackSection.push('ready\n');
      } else {
        ackSection.push('NAK\n');
      }
      sections.push(ackSection);
    }

    if (replyShallow.length > 0 || replyUnshallow.length > 0) {
      const shallowSection: Array<string | Uint8Array> = ['shallow-info\n'];
      replyShallow.sort();
      replyUnshallow.sort();
      for (const s of replyShallow) {
        shallowSection.push(`shallow ${s}\n`);
      }
      for (const u of replyUnshallow) {
        shallowSection.push(`unshallow ${u}\n`);
      }
      sections.push(shallowSection);
    }

    if (includedObjectIds.size > 0) {
      const packSection: Array<string | Uint8Array> = ['packfile\n'];
      const sortedIds = Array.from(includedObjectIds).sort();
      const packObjects: PackObjectInput[] = [];
      for (const id of sortedIds) {
        const obj = getObject(store, id);
        if (obj) {
          packObjects.push({ type: obj.type, id, raw: obj.raw });
        }
      }

      if (packObjects.length > 0) {
        const packBytes = writePack(packObjects);
        const CHUNK_SIZE = 32768;
        for (let offset = 0; offset < packBytes.length; offset += CHUNK_SIZE) {
          const chunk = packBytes.subarray(offset, Math.min(offset + CHUNK_SIZE, packBytes.length));
          const band1Chunk = new Uint8Array(1 + chunk.length);
          band1Chunk[0] = 1;
          band1Chunk.set(chunk, 1);
          packSection.push(band1Chunk);
        }
      }
      sections.push(packSection);
    }

    const fetchChunks: Uint8Array[] = [];
    if (sections.length > 0) {
      for (let sIdx = 0; sIdx < sections.length; sIdx++) {
        const sec = sections[sIdx];
        for (const item of sec) {
          fetchChunks.push(encodePktLine(item));
        }
        if (sIdx < sections.length - 1) {
          fetchChunks.push(encodePktLine(PKT_DELIM));
        } else {
          fetchChunks.push(encodePktLine(PKT_FLUSH));
        }
      }
    } else {
      fetchChunks.push(encodePktLine(PKT_FLUSH));
    }

    const totalLen = fetchChunks.reduce((acc, c) => acc + c.length, 0);
    const bodyBytes = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of fetchChunks) {
      bodyBytes.set(c, offset);
      offset += c.length;
    }

    packCache.set(cacheKey, bodyBytes);

    return {
      status: 200,
      headers: {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': String(bodyBytes.length),
        'cache-control': 'no-cache',
      },
      body: bodyBytes,
    };
  }

  if (command !== 'ls-refs') {
    return sendJsonError(404, 'Not Found');
  }

  if (i < packets.length && packets[i].type === 'delim') {
    i++;
  }

  while (i < packets.length && packets[i].type !== 'flush') {
    const pkt = packets[i];
    if (pkt.type === 'data') {
      let text = new TextDecoder().decode(pkt.payload);
      if (text.endsWith('\n')) text = text.substring(0, text.length - 1);
      if (text === 'peel') {
        peel = true;
      } else if (text === 'symrefs') {
        symrefs = true;
      } else if (text.startsWith('ref-prefix ')) {
        refPrefixes.push(text.substring(11));
      }
    }
    i++;
  }

  const refs = listRefs(store, repo);
  const defaultBranchRef = `refs/heads/${repo.defaultBranch}`;
  const chunks: Uint8Array[] = [];

  if (refs.length === 0 && (!symrefs || !resolveRef(store, repo, 'HEAD'))) {
    chunks.push(encodePktLine(PKT_FLUSH));
  } else {
    if (symrefs) {
      const headTip = resolveRef(store, repo, 'HEAD') || resolveRef(store, repo, defaultBranchRef) || '0000000000000000000000000000000000000000';
      const headName = 'HEAD';
      let includeHead = true;
      if (refPrefixes.length > 0) {
        includeHead = refPrefixes.some(p => headName.startsWith(p));
      }
      if (includeHead) {
        const line = `${headTip} ${headName} symref-target:${defaultBranchRef}\n`;
        chunks.push(encodePktLine(line));
      }
    }

    for (const r of refs) {
      if (refPrefixes.length > 0) {
        const matches = refPrefixes.some(p => r.name.startsWith(p));
        if (!matches) continue;
      }

      let line = `${r.oid} ${r.name}`;
      if (peel && r.name.startsWith('refs/tags/')) {
        const obj = getObject(store, r.oid);
        if (obj && obj.type === 'tag') {
          try {
            const tagObj = parseTag(obj.raw);
            if (isValidOid(tagObj.object)) {
              line += ` peeled:${tagObj.object}`;
            }
          } catch {}
        }
      }
      line += '\n';
      chunks.push(encodePktLine(line));
    }

    chunks.push(encodePktLine(PKT_FLUSH));
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const bodyBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    bodyBytes.set(c, offset);
    offset += c.length;
  }

  return {
    status: 200,
    headers: {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': String(bodyBytes.length),
      'cache-control': 'no-cache',
    },
    body: bodyBytes,
  };
}

interface ReceiveCommand {
  oldOid: string;
  newOid: string;
  refName: string;
  capabilities?: string;
}

function parseReceivePackBody(body: Uint8Array): { commands: ReceiveCommand[]; packBytes?: Uint8Array } {
  let pos = 0;
  const commands: ReceiveCommand[] = [];

  while (pos < body.length) {
    if (pos + 4 > body.length) {
      throw new Error('Truncated pkt-line header');
    }
    const headerHex = new TextDecoder().decode(body.subarray(pos, pos + 4));
    if (headerHex === '0000') {
      pos += 4;
      break;
    }
    const len = parseInt(headerHex, 16);
    if (isNaN(len) || len < 4) {
      throw new Error(`Invalid pkt-line header: ${headerHex}`);
    }
    if (pos + len > body.length) {
      throw new Error('Truncated pkt-line payload');
    }
    const payload = body.subarray(pos + 4, pos + len);
    pos += len;

    let text = new TextDecoder().decode(payload);
    if (text.endsWith('\n')) {
      text = text.substring(0, text.length - 1);
    }

    let capabilities: string | undefined;
    const nulIdx = text.indexOf('\0');
    if (nulIdx !== -1) {
      capabilities = text.substring(nulIdx + 1);
      text = text.substring(0, nulIdx);
    }

    const parts = text.split(' ');
    if (parts.length >= 3) {
      const oldOid = parts[0];
      const newOid = parts[1];
      const refName = parts.slice(2).join(' ');
      commands.push({ oldOid, newOid, refName, capabilities });
    }
  }

  let packBytes: Uint8Array | undefined;
  if (pos < body.length) {
    packBytes = body.subarray(pos);
  }

  return { commands, packBytes };
}

/**
 * Handle smart-HTTP git-receive-pack (push) POST requests.
 */
export function handleGitReceivePack(
  store: Store,
  owner: string,
  repoName: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer | null
): { status: number; headers: Record<string, string>; body: Uint8Array | string } {
  let authHeader: string | undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      authHeader = v;
      break;
    }
  }

  if (!isAuthenticated(authHeader)) {
    return sendJsonError(401, 'Requires authentication');
  }

  if (owner !== viewerLogin) {
    return sendJsonError(404, 'Not Found');
  }

  const repo = getRepository(store, owner, repoName);
  if (!repo) {
    return sendJsonError(404, 'Not Found');
  }

  if (!body || body.length === 0) {
    return sendJsonError(400, 'Bad request body');
  }

  let parsed;
  try {
    parsed = parseReceivePackBody(body);
  } catch {
    return sendJsonError(400, 'Malformed receive-pack body');
  }

  const { commands, packBytes } = parsed;
  if (commands.length === 0) {
    return sendJsonError(400, 'No commands in receive-pack request');
  }

  let unpackFailed = false;
  let unpackErrorMsg = '';
  const parsedObjectsMap = new Map<string, { type: string; raw: Uint8Array }>();

  if (packBytes && packBytes.length > 0) {
    try {
      const lookup = (id: string) => {
        const fromStore = getObject(store, id);
        if (fromStore) return fromStore;
        return parsedObjectsMap.get(id);
      };
      const packResult = readPack(packBytes, lookup);
      for (const [id, obj] of packResult.objects.entries()) {
        parsedObjectsMap.set(id, obj);
        putObject(store, obj.type, obj.raw, id);
      }
    } catch (err: any) {
      unpackFailed = true;
      unpackErrorMsg = err?.message || 'unpack failed';
    }
  }

  const ZERO_OID = '0000000000000000000000000000000000000000';
  const commandResults: Array<{ refName: string; success: boolean; reason?: string }> = [];

  if (!unpackFailed) {
    for (const cmd of commands) {
      const { oldOid, newOid, refName } = cmd;
      const currentTip = resolveRef(store, repo, refName);
      const refExists = currentTip !== null;

      let success = false;
      let reason = '';

      if (oldOid === ZERO_OID && !refExists) {
        setRef(store, repo, refName, newOid);
        success = true;
      } else if (oldOid !== ZERO_OID && refExists && currentTip === oldOid) {
        if (newOid === ZERO_OID) {
          deleteRef(store, repo, refName);
          success = true;
        } else {
          if (isAncestor(store, oldOid, newOid)) {
            setRef(store, repo, refName, newOid);
            success = true;
          } else {
            reason = 'non-fast-forward';
            success = false;
          }
        }
      } else {
        reason = 'non-fast-forward';
        success = false;
      }

      commandResults.push({ refName, success, reason });
    }
  } else {
    for (const cmd of commands) {
      commandResults.push({ refName: cmd.refName, success: false, reason: 'unpack failed' });
    }
  }

  const reportChunks: Uint8Array[] = [];
  if (unpackFailed) {
    const errLine = `unpack error ${unpackErrorMsg}\n`;
    const encodedErr = encodePktLine(errLine);
    const band1Err = new Uint8Array(1 + encodedErr.length);
    band1Err[0] = 1;
    band1Err.set(encodedErr, 1);
    reportChunks.push(encodePktLine(band1Err));

    for (const cmd of commands) {
      const ngLine = `ng ${cmd.refName} unpack failed\n`;
      const encodedNg = encodePktLine(ngLine);
      const band1Ng = new Uint8Array(1 + encodedNg.length);
      band1Ng[0] = 1;
      band1Ng.set(encodedNg, 1);
      reportChunks.push(encodePktLine(band1Ng));
    }
  } else {
    const okLine = 'unpack ok\n';
    const encodedOk = encodePktLine(okLine);
    const band1Ok = new Uint8Array(1 + encodedOk.length);
    band1Ok[0] = 1;
    band1Ok.set(encodedOk, 1);
    reportChunks.push(encodePktLine(band1Ok));

    for (const res of commandResults) {
      let line = '';
      if (res.success) {
        line = `ok ${res.refName}\n`;
      } else {
        line = `ng ${res.refName} ${res.reason}\n`;
      }
      const encodedLine = encodePktLine(line);
      const band1Line = new Uint8Array(1 + encodedLine.length);
      band1Line[0] = 1;
      band1Line.set(encodedLine, 1);
      reportChunks.push(encodePktLine(band1Line));
    }
  }
  // The report-status stream inside band 1 ends with its own flush packet,
  // carried as band-1 data: the four raw bytes 0000, before the outer flush
  // that ends the response.
  const band1Flush = new Uint8Array([1, 0x30, 0x30, 0x30, 0x30]);
  reportChunks.push(encodePktLine(band1Flush));
  reportChunks.push(encodePktLine(PKT_FLUSH));

  const totalLen = reportChunks.reduce((acc, c) => acc + c.length, 0);
  const bodyBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of reportChunks) {
    bodyBytes.set(c, offset);
    offset += c.length;
  }

  return {
    status: 200,
    headers: {
      'content-type': 'application/x-git-receive-pack-result',
      'content-length': String(bodyBytes.length),
      'cache-control': 'no-cache',
    },
    body: bodyBytes,
  };
}
