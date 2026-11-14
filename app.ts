// The server routing and lifecycle implementation wiring REST, smart-HTTP, and health checks.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGitRequest, handleGitReceivePack, handleGitUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_SIZE = 64 * 1024 * 1024; // 64 MiB

let requestIdCounter = 1;

/** Answer one request with a JSON body and standard headers including request ID. */
function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const reqId = `req-${requestIdCounter++}`;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId,
    ...extraHeaders,
  });
  res.end(text);
}

/** Extract pathname from request URL. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Extract query record from request URL search parameters. */
function queryOf(req: IncomingMessage): Record<string, string> {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const query: Record<string, string> = {};
    for (const [key, val] of url.searchParams.entries()) {
      query[key] = val;
    }
    return query;
  } catch {
    return {};
  }
}

/** Read full request body up to MAX_BODY_SIZE, returning a Buffer or throwing/answering 413 if too large. */
async function readRequestBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buf.length;
    if (totalSize > MAX_BODY_SIZE) {
      throw new Error('BODY_TOO_LARGE');
    }
    chunks.push(buf);
  }
  if (totalSize === 0) return null;
  return Buffer.concat(chunks);
}

/** Build the server with shared store instance and route handlers. */
export function createApp(): Server {
  const store = createStore();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // 1. Health check probe
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Read request body with size capping for REST and other methods if needed
    let body: Buffer | null = null;
    try {
      body = await readRequestBody(req);
    } catch (err: any) {
      if (err && err.message === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { message: 'Request entity too large' });
      } else {
        sendJson(res, 400, { message: 'Bad request body' });
      }
      return;
    }

    // 2. GraphQL routing
    if (path === '/api/graphql') {
      const headerMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headerMap[k] = v;
        else if (Array.isArray(v)) headerMap[k] = v[0];
      }

      const gqlRes = handleGraphQL(store, headerMap, body);
      res.writeHead(gqlRes.status, gqlRes.headers);
      if (gqlRes.body !== null) {
        res.end(gqlRes.body);
      } else {
        res.end();
      }
      return;
    }

    // 3. REST v3 routing
    if (path.startsWith('/api/v3')) {
      const query = queryOf(req);
      const restReq = {
        method,
        pathname: path,
        query,
        getHeader(name: string): string | null {
          const val = req.headers[name.toLowerCase()];
          if (Array.isArray(val)) return val[0];
          return val ?? null;
        },
        body,
      };

      const restRes = handleRest(store, restReq);
      res.writeHead(restRes.status, restRes.headers);
      if (restRes.body !== null) {
        res.end(restRes.body);
      } else {
        res.end();
      }
      return;
    }

    // 3. Smart-HTTP routes: /<owner>/<repo>.git/...
    // Matches patterns:
    // /<owner>/<repo>.git/info/refs
    // /<owner>/<repo>.git/git-upload-pack
    // /<owner>/<repo>.git/git-receive-pack
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
    if (gitMatch) {
      const owner = gitMatch[1];
      const repoName = gitMatch[2];
      const subPath = gitMatch[3] ?? '/';

      const query = queryOf(req);
      const headerMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headerMap[k] = v;
        else if (Array.isArray(v)) headerMap[k] = v[0];
      }

      if (subPath === '/info/refs') {
        const service = query['service'];
        const serviceName = service || (method === 'POST' ? path.substring(path.lastIndexOf('/') + 1) : '');
        const gitRes = handleGitRequest(store, owner, repoName, serviceName, headerMap, query);
        res.writeHead(gitRes.status, gitRes.headers);
        res.end(gitRes.body);
        return;
      }

      if (subPath === '/git-upload-pack') {
        const gitRes = handleGitUploadPack(store, owner, repoName, headerMap, body);
        res.writeHead(gitRes.status, gitRes.headers);
        res.end(gitRes.body);
        return;
      }

      if (subPath === '/git-receive-pack') {
        const gitRes = handleGitReceivePack(store, owner, repoName, headerMap, body);
        res.writeHead(gitRes.status, gitRes.headers);
        res.end(gitRes.body);
        return;
      }
    }

    // 5. Unknown routes: 404 with JSON message body and non-empty X-GitHub-Request-Id header.
    sendJson(res, 404, { message: 'Not Found' });
  });
}
