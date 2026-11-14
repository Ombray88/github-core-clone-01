import { canMergePullRequest, squashMergePullRequest } from "./store.ts";
import { resolveRef } from "./store.ts";
import { type Store, isAuthenticated, createRepository, getRepository, type Issue, type PullRequest, makeGlobalId } from './store.ts';

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'PR title' },
        head: { type: 'string', description: 'Head branch' },
        base: { type: 'string', description: 'Base branch' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and repo name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
].sort((a, b) => a.name.localeCompare(b.name));

let requestIdCounter = 1;

export function handleMcp(
  store: Store,
  headers: Record<string, string>,
  body: Buffer | null
): { status: number; headers: Record<string, string>; body: string | null } {
  const reqIdHeader = `req-mcp-${requestIdCounter++}`;
  const respHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': reqIdHeader,
  };

  if (!body || body.length === 0) {
    return {
      status: 400,
      headers: respHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: empty body' },
        id: null,
      }),
    };
  }

  let json: any;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch (err) {
    return {
      status: 400,
      headers: respHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: invalid JSON' },
        id: null,
      }),
    };
  }

  const { jsonrpc, id, method, params } = json;

  if (jsonrpc !== '2.0') {
    return {
      status: 200,
      headers: respHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request: missing or invalid jsonrpc version' },
        id: id ?? null,
      }),
    };
  }

  const isNotification = id === undefined || id === null;

  if (method === 'notifications/initialized') {
    if (isNotification) {
      return {
        status: 202,
        headers: respHeaders,
        body: null,
      };
    }
  }

  if (method === 'initialize') {
    return {
      status: 200,
      headers: respHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: 'github-core-clone', version: '1.0.0' },
        },
        id: id ?? null,
      }),
    };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      headers: respHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          serverInfo: { name: 'github-core-clone', version: '1.0.0' },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' },
          },
        },
        id: id ?? null,
      }),
    };
  }

  if (method === 'tools/list') {
    return {
      status: 200,
      headers: respHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        result: {
          tools: TOOLS,
        },
        id: id ?? null,
      }),
    };
  }

  if (method === 'tools/call') {
    const authHeader = headers['authorization'] ?? headers['Authorization'] ?? null;
    if (!isAuthenticated(authHeader)) {
      return {
        status: 401,
        headers: respHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: id ?? null,
        }),
      };
    }

    const toolName = params?.name;
    const args = params?.arguments ?? {};

    if (!toolName || typeof toolName !== 'string') {
      return {
        status: 200,
        headers: respHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid params: tool name missing' },
          id: id ?? null,
        }),
      };
    }

    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      return {
        status: 200,
        headers: respHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
          id: id ?? null,
        }),
      };
    }

    try {
      if (toolName === 'create_repo') {
        if (!args.name || typeof args.name !== 'string') {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Missing required argument: name' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const repo = createRepository(
          store,
          args.name,
          args.description ?? '',
          !!args.private
        );
        if (!repo) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Repository already exists or creation failed' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        return {
          status: 200,
          headers: respHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            result: {
              content: [{ type: 'text', text: JSON.stringify(repo) }],
              isError: false,
            },
            id: id ?? null,
          }),
        };
      }

      if (toolName === 'get_repo') {
        if (!args.owner || !args.repo || typeof args.owner !== 'string' || typeof args.repo !== 'string') {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Missing required arguments: owner and repo' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const repo = getRepository(store, args.owner, args.repo);
        if (!repo) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Repository not found' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        return {
          status: 200,
          headers: respHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            result: {
              content: [{ type: 'text', text: JSON.stringify(repo) }],
              isError: false,
            },
            id: id ?? null,
          }),
        };
      }

      if (toolName === 'list_issues') {
        if (!args.owner || !args.repo || typeof args.owner !== 'string' || typeof args.repo !== 'string') {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Missing required arguments: owner and repo' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const repo = getRepository(store, args.owner, args.repo);
        if (!repo) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Repository not found' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const stateFilter = args.state ?? 'open';
        let issues = repo.issues;
        if (stateFilter !== 'all') {
          issues = issues.filter((i) => i.state === stateFilter);
        }
        return {
          status: 200,
          headers: respHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            result: {
              content: [{ type: 'text', text: JSON.stringify({ issues }) }],
              isError: false,
            },
            id: id ?? null,
          }),
        };
      }

      if (toolName === 'create_issue') {
        const owner = args['owner'];
        const repoName = args['repo'];
        const title = args['title'];
        const body = args['body'];
        if (!owner || !repoName || !title) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Missing required arguments: owner, repo, title' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const repository = store.repositories.get(`${owner}/${repoName}`);
        if (!repository) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Repository not found' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const num = repository.nextIssueNumber++;
        const issue: Issue = {
          id: makeGlobalId('issue', repository.fullName, num),
          number: num,
          title: String(title),
          body: typeof body === 'string' ? body : '',
          state: 'open',
          labels: [],
          comments: [],
        };
        repository.issues.push(issue);
        return {
          status: 200,
          headers: respHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            result: {
              content: [{ type: 'text', text: JSON.stringify(issue) }],
              isError: false,
            },
            id: id ?? null,
          }),
        };
      }

      if (toolName === 'create_pull_request') {
        const owner = args['owner'];
        const repoName = args['repo'];
        const title = args['title'];
        const head = args['head'];
        const base = args['base'];
        const body = args['body'];
        if (!owner || !repoName || !title || !head || !base) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Missing required arguments: owner, repo, title, head, base' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const targetRepo = store.repositories.get(`${owner}/${repoName}`);
        if (!targetRepo) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Repository not found' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const headCommitId = resolveRef(store, targetRepo, 'refs/heads/' + head);
        const baseCommitId = resolveRef(store, targetRepo, 'refs/heads/' + base);
        if (!headCommitId || !baseCommitId) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Branch not found' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const num = targetRepo.nextIssueNumber++;
        const pr: PullRequest = {
          id: makeGlobalId('pull_request', targetRepo.fullName, num),
          number: num,
          title: String(title),
          body: typeof body === 'string' ? body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitId: null,
          head: String(head),
          base: String(base),
          headCommitId: headCommitId,
          baseCommitId: baseCommitId,
          changedFiles: [],
        };
        targetRepo.pullRequests.push(pr);
        return {
          status: 200,
          headers: respHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            result: {
              content: [{ type: 'text', text: JSON.stringify(pr) }],
              isError: false,
            },
            id: id ?? null,
          }),
        };
      }

      if (toolName === 'merge_pull_request') {
        const owner = args['owner'];
        const repoName = args['repo'];
        const pullNum = parseInt(args['pull_number'] ?? args['pullNumber'], 10);
        if (!owner || !repoName || isNaN(pullNum)) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Missing required arguments: owner, repo, pull_number' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const targetRepo = store.repositories.get(`${owner}/${repoName}`);
        if (!targetRepo) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Repository not found' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        const pr = targetRepo.pullRequests.find((p) => p.number === pullNum);
        if (!pr) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Pull request not found' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        if (!canMergePullRequest(store, targetRepo, pr)) {
          return {
            status: 200,
            headers: respHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              result: {
                content: [{ type: 'text', text: 'Pull request cannot be merged' }],
                isError: true,
              },
              id: id ?? null,
            }),
          };
        }
        squashMergePullRequest(store, targetRepo, pr, `Merge pull request #${pr.number} from ${pr.head}`);
        return {
          status: 200,
          headers: respHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            result: {
              content: [{ type: 'text', text: JSON.stringify(pr) }],
              isError: false,
            },
            id: id ?? null,
          }),
        };
      }

      return {
        status: 200,
        headers: respHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          result: {
            content: [{ type: 'text', text: `Tool ${toolName} not implemented yet` }],
            isError: true,
          },
          id: id ?? null,
        }),
      };
    } catch (err: any) {
      return {
        status: 200,
        headers: respHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          result: {
            content: [{ type: 'text', text: err?.message ?? 'Internal tool execution error' }],
            isError: true,
          },
          id: id ?? null,
        }),
      };
    }
  }

  return {
    status: 200,
    headers: respHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Method not found: ${method}` },
      id: id ?? null,
    }),
  };
}
