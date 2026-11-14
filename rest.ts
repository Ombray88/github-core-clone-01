import type { Store, Repository, Issue, PullRequest, Label, Comment } from './store.ts';
import {
  viewerLogin,
  viewerId,
  isAuthenticated,
  makeGlobalId,
  createRepository,
  getRepository,
  listViewerRepositories,
  deleteRepository,
  resolveRef,
  setRef,
  getObject,
  commitFile,
  readFileAtRef,
  listDirectoryAtRef,
  diffTrees,
  canMergePullRequest,
  squashMergePullRequest,
} from './store.ts';

export interface RestRequest {
  method: string;
  pathname: string;
  query: Record<string, string>;
  getHeader(name: string): string | null;
  body: Buffer | null;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

let requestIdCounter = 1;

function makeHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const reqId = `req-${requestIdCounter++}`;
  return {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': reqId,
    ...extraHeaders,
  };
}

function jsonReply(status: number, data: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: makeHeaders(extraHeaders),
    body: JSON.stringify(data),
  };
}

function errorReply(status: number, message: string): RestResponse {
  return jsonReply(status, { message });
}

function getHeaderValue(req: RestRequest, name: string): string | null {
  const target = name.toLowerCase();
  const direct = req.getHeader(name);
  if (direct !== null) return direct;
  const lower = req.getHeader(target);
  if (lower !== null) return lower;
  return req.getHeader(name.toUpperCase());
}

function parsePositiveInt(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultVal : parsed;
}

function parseCommit(raw: Uint8Array): { tree: string; parents: string[]; author: string; committer: string; message: string } {
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

function formatRepo(repo: Repository) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: { login: repo.owner },
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function formatIssue(issue: Issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function formatPullRequest(pr: PullRequest) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head, sha: pr.headCommitId },
    base: { ref: pr.base, sha: pr.baseCommitId },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitId,
  };
}

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const method = req.method.toUpperCase();
  const pathname = req.pathname;
  const query = req.query ?? {};

  // Authentication check
  const authHeader = getHeaderValue(req, 'authorization');
  if (!isAuthenticated(authHeader)) {
    return errorReply(401, 'Requires authentication');
  }

  // Parse request body if present
  let bodyObj: any = {};
  if (req.body !== null && req.body.length > 0) {
    try {
      bodyObj = JSON.parse(req.body.toString('utf-8'));
    } catch {
      return errorReply(400, 'Invalid JSON body');
    }
    if (bodyObj === null || typeof bodyObj !== 'object') {
      bodyObj = {};
    }
  }

  // API prefix check
  if (!pathname.startsWith('/api/v3')) {
    return errorReply(404, 'Not Found');
  }

  // 1. GET /api/v3/ or GET /api/v3
  if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
    return jsonReply(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'X-OAuth-Scopes': 'repo, read:org' }
    );
  }

  // 2. GET /api/v3/meta
  if (method === 'GET' && pathname === '/api/v3/meta') {
    return jsonReply(200, { installed_version: '1.0.0' });
  }

  // 3. GET /api/v3/user
  if (method === 'GET' && pathname === '/api/v3/user') {
    return jsonReply(200, {
      login: viewerLogin,
      id: viewerId,
    });
  }

  // 4. GET /api/v3/user/repos
  if (method === 'GET' && pathname === '/api/v3/user/repos') {
    const allRepos = listViewerRepositories(store);
    const perPage = parsePositiveInt(query.per_page, 30);
    const page = parsePositiveInt(query.page, 1);
    const startIndex = (page - 1) * perPage;
    const pageRepos = allRepos.slice(startIndex, startIndex + perPage);

    const extraHeaders: Record<string, string> = {};
    if (page * perPage < allRepos.length) {
      const host = getHeaderValue(req, 'host') ?? 'localhost';
      const scheme = getHeaderValue(req, 'x-forwarded-proto') ?? 'http';
      const nextPage = page + 1;
      const nextUrl = `${scheme}://${host}/api/v3/user/repos?per_page=${perPage}&page=${nextPage}`;
      extraHeaders['Link'] = `<${nextUrl}>; rel="next"`;
    }

    return jsonReply(200, pageRepos.map(formatRepo), extraHeaders);
  }

  // 5. POST /api/v3/user/repos
  if (method === 'POST' && pathname === '/api/v3/user/repos') {
    const name = bodyObj.name;
    if (typeof name !== 'string' || !name.trim()) {
      return errorReply(422, 'Repository name is required');
    }
    const description = typeof bodyObj.description === 'string' ? bodyObj.description : '';
    const privateFlag = Boolean(bodyObj.private);

    const created = createRepository(store, name, description, privateFlag);
    if (!created) {
      return errorReply(422, 'Repository already exists');
    }
    return jsonReply(201, formatRepo(created));
  }

  // Routes under /api/v3/repos/{owner}/{repo}
  const repoMatch = pathname.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (repoMatch) {
    const owner = repoMatch[1];
    const repoName = repoMatch[2];
    const subpath = repoMatch[3] ?? '';

    // Viewer ownership check
    if (owner !== viewerLogin) {
      return errorReply(404, 'Not Found');
    }

    // 6. GET /api/v3/repos/{owner}/{repo}
    if (method === 'GET' && (subpath === '' || subpath === '/')) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');
      return jsonReply(200, formatRepo(repo));
    }

    // 7. PATCH /api/v3/repos/{owner}/{repo}
    if (method === 'PATCH' && (subpath === '' || subpath === '/')) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');
      if (typeof bodyObj.description === 'string') {
        repo.description = bodyObj.description;
      }
      return jsonReply(200, formatRepo(repo));
    }

    // 8. DELETE /api/v3/repos/{owner}/{repo}
    if (method === 'DELETE' && (subpath === '' || subpath === '/')) {
      const ok = deleteRepository(store, owner, repoName);
      if (!ok) return errorReply(404, 'Not Found');
      return { status: 204, headers: makeHeaders(), body: null };
    }

    // 9. POST /api/v3/repos/{owner}/{repo}/git/refs
    if (method === 'POST' && subpath === '/git/refs') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const refName = bodyObj.ref;
      const sha = bodyObj.sha;
      if (typeof refName !== 'string' || typeof sha !== 'string') {
        return errorReply(422, 'Invalid ref or sha');
      }

      const fullName = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
      if (repo.refs.has(fullName) || repo.refs.has(refName)) {
        return errorReply(422, 'Reference already exists');
      }

      setRef(store, repo, refName, sha);
      return jsonReply(201, {
        ref: fullName,
        object: { sha },
      });
    }

    // 10. GET /api/v3/repos/{owner}/{repo}/git/refs/heads/{branch}
    if (method === 'GET' && subpath.startsWith('/git/refs/heads/')) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const branch = subpath.slice('/git/refs/heads/'.length);
      const fullName = `refs/heads/${branch}`;
      const sha = resolveRef(store, repo, fullName) ?? resolveRef(store, repo, branch);
      if (!sha) return errorReply(404, 'Not Found');

      return jsonReply(200, {
        ref: fullName,
        object: { sha },
      });
    }

    // 11. GET /api/v3/repos/{owner}/{repo}/branches
    if (method === 'GET' && subpath === '/branches') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const branchNames = new Set<string>();
      for (const k of repo.refs.keys()) {
        if (k.startsWith('refs/heads/')) {
          branchNames.add(k.slice('refs/heads/'.length));
        }
      }
      if (resolveRef(store, repo, repo.defaultBranch)) {
        branchNames.add(repo.defaultBranch);
      }

      const branches: Array<{ name: string; commit: { sha: string } }> = [];
      for (const name of Array.from(branchNames).sort()) {
        const sha = resolveRef(store, repo, `refs/heads/${name}`) ?? resolveRef(store, repo, name);
        if (sha) {
          branches.push({ name, commit: { sha } });
        }
      }

      return jsonReply(200, branches);
    }

    // 12. GET /api/v3/repos/{owner}/{repo}/branches/{branch}
    if (method === 'GET' && subpath.startsWith('/branches/')) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const branch = subpath.slice('/branches/'.length);
      const sha = resolveRef(store, repo, `refs/heads/${branch}`) ?? resolveRef(store, repo, branch);
      if (!sha) return errorReply(404, 'Not Found');

      return jsonReply(200, {
        name: branch,
        commit: { sha },
      });
    }

    // 13. GET /api/v3/repos/{owner}/{repo}/commits
    if (method === 'GET' && subpath === '/commits') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const targetRef = query.sha ?? repo.defaultBranch;
      const tipSha = resolveRef(store, repo, targetRef);
      if (!tipSha) return errorReply(404, 'Not Found');

      const commits: Array<{ sha: string; commit: { message: string } }> = [];
      const visited = new Set<string>();
      const queue = [tipSha];

      while (queue.length > 0) {
        const currentSha = queue.shift()!;
        if (visited.has(currentSha)) continue;
        visited.add(currentSha);

        const obj = getObject(store, currentSha);
        if (!obj || obj.type !== 'commit') continue;

        const parsed = parseCommit(obj.raw);
        commits.push({
          sha: currentSha,
          commit: { message: parsed.message.endsWith('\n') ? parsed.message.slice(0, -1) : parsed.message },
        });

        for (const parent of parsed.parents) {
          if (!visited.has(parent)) {
            queue.push(parent);
          }
        }
      }

      return jsonReply(200, commits);
    }

    // 14. PUT /api/v3/repos/{owner}/{repo}/contents/{path}
    if (method === 'PUT' && subpath.startsWith('/contents/')) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const filePath = subpath.slice('/contents/'.length);
      const targetBranch = typeof bodyObj.branch === 'string' ? bodyObj.branch : repo.defaultBranch;
      const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Update file';
      const base64Content = typeof bodyObj.content === 'string' ? bodyObj.content : '';
      const newBytes = Buffer.from(base64Content, 'base64');

      const existing = readFileAtRef(store, repo, targetBranch, filePath);
      if (existing !== null) {
        if (typeof bodyObj.sha === 'string' && bodyObj.sha !== existing.blobId) {
          return errorReply(409, 'Stale SHA');
        }
      }

      const { commitId, blobId } = commitFile(store, repo, targetBranch, filePath, newBytes, message);
      const status = existing === null ? 201 : 200;

      return jsonReply(status, {
        content: {
          sha: blobId,
          encoding: 'base64',
        },
        commit: {
          sha: commitId,
        },
      });
    }

    // 15. GET /api/v3/repos/{owner}/{repo}/contents/{path} or /contents
    if (method === 'GET' && (subpath === '/contents' || subpath.startsWith('/contents/'))) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      let filePath = subpath.startsWith('/contents/') ? subpath.slice('/contents/'.length) : '';
      filePath = filePath.replace(/^\/+|\/+$/g, '');
      const ref = typeof query.ref === 'string' ? query.ref : repo.defaultBranch;

      if (filePath !== '') {
        const file = readFileAtRef(store, repo, ref, filePath);
        if (file !== null) {
          return jsonReply(200, {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(file.bytes).toString('base64'),
            sha: file.blobId,
            size: file.bytes.length,
          });
        }
      }

      const dirEntries = listDirectoryAtRef(store, repo, ref, filePath);
      if (dirEntries !== null) {
        const result = dirEntries.map((e) => ({
          type: e.type,
          name: e.name,
          path: e.path,
          sha: e.id,
        }));
        return jsonReply(200, result);
      }

      return errorReply(404, 'Not Found');
    }

    // 16. DELETE /api/v3/repos/{owner}/{repo}/contents/{path}
    if (method === 'DELETE' && subpath.startsWith('/contents/')) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const filePath = subpath.slice('/contents/'.length);
      const targetBranch = typeof bodyObj.branch === 'string' ? bodyObj.branch : repo.defaultBranch;
      const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Delete file';

      const existing = readFileAtRef(store, repo, targetBranch, filePath);
      if (existing === null) {
        return errorReply(404, 'File not found');
      }
      if (typeof bodyObj.sha === 'string' && bodyObj.sha !== existing.blobId) {
        return errorReply(409, 'Stale SHA');
      }

      const { commitId } = commitFile(store, repo, targetBranch, filePath, null, message);
      return jsonReply(200, {
        commit: {
          sha: commitId,
        },
      });
    }

    // 17. POST /api/v3/repos/{owner}/{repo}/labels
    if (method === 'POST' && subpath === '/labels') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const name = bodyObj.name;
      const color = bodyObj.color ?? 'ffffff';
      if (typeof name !== 'string' || !name) {
        return errorReply(422, 'Label name required');
      }

      const label: Label = { name, color };
      repo.labels.set(name, label);
      return jsonReply(201, { name: label.name, color: label.color });
    }

    // 18. GET /api/v3/repos/{owner}/{repo}/labels
    if (method === 'GET' && subpath === '/labels') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const labels = Array.from(repo.labels.values());
      return jsonReply(200, labels);
    }

    // 19. POST /api/v3/repos/{owner}/{repo}/issues
    if (method === 'POST' && subpath === '/issues') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const labelNames: string[] = Array.isArray(bodyObj.labels) ? bodyObj.labels : [];
      for (const lname of labelNames) {
        if (!repo.labels.has(lname)) {
          return errorReply(422, `Label ${lname} does not exist`);
        }
      }

      const num = repo.nextIssueNumber++;
      const issue: Issue = {
        id: makeGlobalId('issue', repo.fullName, num),
        number: num,
        title: typeof bodyObj.title === 'string' ? bodyObj.title : '',
        body: typeof bodyObj.body === 'string' ? bodyObj.body : '',
        state: 'open',
        labels: labelNames,
        comments: [],
      };
      repo.issues.push(issue);

      return jsonReply(201, formatIssue(issue));
    }

    // 20. GET /api/v3/repos/{owner}/{repo}/issues
    if (method === 'GET' && subpath === '/issues') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const stateFilter = query.state ?? 'open';
      let filtered = repo.issues;
      if (stateFilter === 'open') {
        filtered = filtered.filter((i) => i.state === 'open');
      } else if (stateFilter === 'closed') {
        filtered = filtered.filter((i) => i.state === 'closed');
      }

      const direction = query.direction ?? 'desc';
      filtered = [...filtered].sort((a, b) =>
        direction === 'asc' ? a.number - b.number : b.number - a.number
      );

      const perPage = parsePositiveInt(query.per_page, 30);
      const page = parsePositiveInt(query.page, 1);
      const startIndex = (page - 1) * perPage;
      const pageIssues = filtered.slice(startIndex, startIndex + perPage);

      const extraHeaders: Record<string, string> = {};
      if (page * perPage < filtered.length) {
        const host = getHeaderValue(req, 'host') ?? 'localhost';
        const scheme = getHeaderValue(req, 'x-forwarded-proto') ?? 'http';
        const nextPage = page + 1;
        const nextUrl = `${scheme}://${host}/api/v3/repos/${owner}/${repoName}/issues?per_page=${perPage}&page=${nextPage}`;
        extraHeaders['Link'] = `<${nextUrl}>; rel="next"`;
      }

      return jsonReply(200, pageIssues.map(formatIssue), extraHeaders);
    }

    // 21. GET /api/v3/repos/{owner}/{repo}/issues/{number}
    if (method === 'GET' && /^\/issues\/\d+$/.test(subpath)) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const issueNum = parseInt(subpath.slice('/issues/'.length), 10);
      const issue = repo.issues.find((i) => i.number === issueNum);
      if (!issue) return errorReply(404, 'Not Found');

      return jsonReply(200, formatIssue(issue));
    }

    // 22. PATCH /api/v3/repos/{owner}/{repo}/issues/{number}
    if (method === 'PATCH' && /^\/issues\/\d+$/.test(subpath)) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const issueNum = parseInt(subpath.slice('/issues/'.length), 10);
      const issue = repo.issues.find((i) => i.number === issueNum);
      if (!issue) return errorReply(404, 'Not Found');

      if (bodyObj.state === 'open' || bodyObj.state === 'closed') {
        issue.state = bodyObj.state;
      }

      return jsonReply(200, formatIssue(issue));
    }

    // 23. POST /api/v3/repos/{owner}/{repo}/issues/{number}/comments
    if (method === 'POST' && /^\/issues\/\d+\/comments$/.test(subpath)) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const match = subpath.match(/^\/issues\/(\d+)\/comments$/)!;
      const issueNum = parseInt(match[1], 10);
      const issue = repo.issues.find((i) => i.number === issueNum);
      if (!issue) return errorReply(404, 'Not Found');

      const commentId = repo.nextCommentId++;
      const comment: Comment = {
        id: commentId,
        body: typeof bodyObj.body === 'string' ? bodyObj.body : '',
      };
      issue.comments.push(comment);

      return jsonReply(201, {
        id: comment.id,
        body: comment.body,
      });
    }

    // 24. GET /api/v3/repos/{owner}/{repo}/issues/{number}/comments
    if (method === 'GET' && /^\/issues\/\d+\/comments$/.test(subpath)) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const match = subpath.match(/^\/issues\/(\d+)\/comments$/)!;
      const issueNum = parseInt(match[1], 10);
      const issue = repo.issues.find((i) => i.number === issueNum);
      if (!issue) return errorReply(404, 'Not Found');

      const result = issue.comments.map((c) => ({
        id: c.id,
        body: c.body,
      }));
      return jsonReply(200, result);
    }

    // 25. POST /api/v3/repos/{owner}/{repo}/pulls
    if (method === 'POST' && subpath === '/pulls') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const headRef = bodyObj.head;
      const baseRef = bodyObj.base;
      if (typeof headRef !== 'string' || typeof baseRef !== 'string') {
        return errorReply(422, 'head and base branches required');
      }

      const headSha = resolveRef(store, repo, headRef);
      if (!headSha) return errorReply(422, 'Head branch does not exist');
      const baseSha = resolveRef(store, repo, baseRef);
      if (!baseSha) return errorReply(422, 'Base branch does not exist');

      const headCommitObj = getObject(store, headSha);
      const baseCommitObj = getObject(store, baseSha);
      const headTreeId = headCommitObj && headCommitObj.type === 'commit' ? parseCommit(headCommitObj.raw).tree : null;
      const baseTreeId = baseCommitObj && baseCommitObj.type === 'commit' ? parseCommit(baseCommitObj.raw).tree : null;
      const changedFiles = diffTrees(store, baseTreeId, headTreeId);

      const num = repo.nextIssueNumber++;
      const pr: PullRequest = {
        id: makeGlobalId('pull', repo.fullName, num),
        number: num,
        title: typeof bodyObj.title === 'string' ? bodyObj.title : '',
        body: typeof bodyObj.body === 'string' ? bodyObj.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitId: null,
        head: headRef,
        base: baseRef,
        headCommitId: headSha,
        baseCommitId: baseSha,
        changedFiles,
      };
      repo.pullRequests.push(pr);

      return jsonReply(201, formatPullRequest(pr));
    }

    // 26. GET /api/v3/repos/{owner}/{repo}/pulls
    if (method === 'GET' && subpath === '/pulls') {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const stateFilter = query.state ?? 'open';
      let filtered = repo.pullRequests;
      if (stateFilter === 'open') {
        filtered = filtered.filter((pr) => pr.state === 'open');
      } else if (stateFilter === 'closed') {
        filtered = filtered.filter((pr) => pr.state === 'closed' && !pr.merged);
      }

      const perPage = parsePositiveInt(query.per_page, 30);
      const page = parsePositiveInt(query.page, 1);
      const startIndex = (page - 1) * perPage;
      const pagePulls = filtered.slice(startIndex, startIndex + perPage);

      const extraHeaders: Record<string, string> = {};
      if (page * perPage < filtered.length) {
        const host = getHeaderValue(req, 'host') ?? 'localhost';
        const scheme = getHeaderValue(req, 'x-forwarded-proto') ?? 'http';
        const nextPage = page + 1;
        const nextUrl = `${scheme}://${host}/api/v3/repos/${owner}/${repoName}/pulls?per_page=${perPage}&page=${nextPage}`;
        extraHeaders['Link'] = `<${nextUrl}>; rel="next"`;
      }

      return jsonReply(200, pagePulls.map(formatPullRequest), extraHeaders);
    }

    // 27. GET /api/v3/repos/{owner}/{repo}/pulls/{number}
    if (method === 'GET' && /^\/pulls\/\d+$/.test(subpath)) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const prNum = parseInt(subpath.slice('/pulls/'.length), 10);
      const pr = repo.pullRequests.find((p) => p.number === prNum);
      if (!pr) return errorReply(404, 'Not Found');

      return jsonReply(200, formatPullRequest(pr));
    }

    // 28. GET /api/v3/repos/{owner}/{repo}/pulls/{number}/files
    if (method === 'GET' && /^\/pulls\/\d+\/files$/.test(subpath)) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const match = subpath.match(/^\/pulls\/(\d+)\/files$/)!;
      const prNum = parseInt(match[1], 10);
      const pr = repo.pullRequests.find((p) => p.number === prNum);
      if (!pr) return errorReply(404, 'Not Found');

      const files = pr.changedFiles.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      }));

      return jsonReply(200, files);
    }

    // 29. PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge
    if (method === 'PUT' && /^\/pulls\/\d+\/merge$/.test(subpath)) {
      const repo = getRepository(store, owner, repoName);
      if (!repo) return errorReply(404, 'Not Found');

      const match = subpath.match(/^\/pulls\/(\d+)\/merge$/)!;
      const prNum = parseInt(match[1], 10);
      const pr = repo.pullRequests.find((p) => p.number === prNum);
      if (!pr) return errorReply(404, 'Not Found');

      if (!canMergePullRequest(store, repo, pr)) {
        return errorReply(405, 'Pull Request cannot be merged');
      }

      const commitMsg = bodyObj.commit_message ?? bodyObj.commit_title;
      const mergeSha = squashMergePullRequest(store, repo, pr, commitMsg);

      return jsonReply(200, {
        merged: true,
        sha: mergeSha,
        message: 'Pull Request successfully merged',
      });
    }
  }

  return errorReply(404, 'Not Found');
}
