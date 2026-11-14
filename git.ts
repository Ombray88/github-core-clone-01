import type { Store } from './store.ts';
import {
  isAuthenticated,
  viewerLogin,
  getRepository,
  listRefs,
  resolveRef,
  getObject,
} from './store.ts';
import { encodePktLine, PKT_FLUSH, parseTag } from './gitlib.ts';

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
    chunks.push(encodePktLine('fetch=listing shallow ofs-delta thin-pack\n'));
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
