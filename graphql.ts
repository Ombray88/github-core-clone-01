import {
  type Store,
  type Repository,
  type PullRequest,
  type Issue,
  type Comment,
  viewerLogin,
  isAuthenticated,
  makeGlobalId,
  getRepository,
  canMergePullRequest,
  squashMergePullRequest,
  resolveRef,
} from './store.ts';

// ---------------------------------------------------------------- GraphQL Tokenizer & Parser

export type TokenType =
  | 'IDENT'
  | 'INT'
  | 'FLOAT'
  | 'STRING'
  | 'PUNCT'
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  start: number;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '#' || (c <= ' ' && c !== '\n' && c !== '\r' && c !== '\t')) {
      if (c === '#') {
        while (i < source.length && source[i] !== '\n') i++;
      } else {
        i++;
      }
      continue;
    }
    if (c === '\n' || c === '\r' || c === '\t' || c === ' ') {
      i++;
      continue;
    }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === ':' || c === '=' || c === '$' || c === ',' || c === '[' || c === ']' || c === '!' || c === '@') {
      tokens.push({ type: 'PUNCT', value: c, start: i });
      i++;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'PUNCT', value: '...', start: i });
      i += 3;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let str = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          i++;
          const esc = source[i];
          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else if (esc === '"') str += '"';
          else if (esc === '\\') str += '\\';
          else str += esc;
        } else {
          str += source[i];
        }
        i++;
      }
      i++;
      tokens.push({ type: 'STRING', value: str, start });
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '-' && i + 1 < source.length && source[i + 1] >= '0' && source[i + 1] <= '9')) {
      const start = i;
      let isFloat = false;
      if (c === '-') i++;
      while (i < source.length && ((source[i] >= '0' && source[i] <= '9') || source[i] === '.' || source[i] === 'e' || source[i] === 'E' || source[i] === '+' || source[i] === '-')) {
        if (source[i] === '.') isFloat = true;
        i++;
      }
      const val = source.slice(start, i);
      tokens.push({ type: isFloat ? 'FLOAT' : 'INT', value: val, start });
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      const start = i;
      while (i < source.length && ((source[i] >= 'a' && source[i] <= 'z') || (source[i] >= 'A' && source[i] <= 'Z') || (source[i] >= '0' && source[i] <= '9') || source[i] === '_')) {
        i++;
      }
      const val = source.slice(start, i);
      tokens.push({ type: 'IDENT', value: val, start });
      continue;
    }
    tokens.push({ type: 'PUNCT', value: c, start: i });
    i++;
  }
  tokens.push({ type: 'EOF', value: '', start: source.length });
  return tokens;
}

export interface ASTNode {
  kind: string;
}

export interface DocumentNode extends ASTNode {
  kind: 'Document';
  definitions: DefinitionNode[];
}

export type DefinitionNode = OperationDefinitionNode | FragmentDefinitionNode;

export interface OperationDefinitionNode extends ASTNode {
  kind: 'OperationDefinition';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinitionNode[];
  selectionSet: SelectionSetNode;
}

export interface VariableDefinitionNode extends ASTNode {
  kind: 'VariableDefinition';
  variable: string;
  type: string;
  defaultValue?: any;
}

export interface SelectionSetNode extends ASTNode {
  kind: 'SelectionSet';
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

export interface FieldNode extends ASTNode {
  kind: 'Field';
  alias?: string;
  name: string;
  arguments: ArgumentNode[];
  selectionSet?: SelectionSetNode;
}

export interface ArgumentNode extends ASTNode {
  kind: 'Argument';
  name: string;
  value: any;
}

export interface InlineFragmentNode extends ASTNode {
  kind: 'InlineFragment';
  typeCondition?: string;
  selectionSet: SelectionSetNode;
}

export interface FragmentSpreadNode extends ASTNode {
  kind: 'FragmentSpread';
  name: string;
}

export interface FragmentDefinitionNode extends ASTNode {
  kind: 'FragmentDefinition';
  name: string;
  typeCondition: string;
  selectionSet: SelectionSetNode;
}

export class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos] || { type: 'EOF', value: '', start: 0 };
  }

  consume(): Token {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) {
      this.pos++;
    }
    return t;
  }

  expect(value?: string, type?: TokenType): Token {
    const t = this.peek();
    if (type && t.type !== type) {
      throw new Error(`Expected token type ${type}, got ${t.type} (${t.value})`);
    }
    if (value && t.value !== value) {
      throw new Error(`Expected token '${value}', got '${t.value}'`);
    }
    return this.consume();
  }

  parseDocument(): DocumentNode {
    const definitions: DefinitionNode[] = [];
    while (this.peek().type !== 'EOF') {
      definitions.push(this.parseDefinition());
    }
    return { kind: 'Document', definitions };
  }

  parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.type === 'IDENT' && t.value === 'fragment') {
      return this.parseFragmentDefinition();
    }
    return this.parseOperationDefinition();
  }

  parseOperationDefinition(): OperationDefinitionNode {
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | undefined;
    let variableDefinitions: VariableDefinitionNode[] = [];

    const t = this.peek();
    if (t.type === 'IDENT' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      operation = this.consume().value as any;
      if (this.peek().type === 'IDENT') {
        name = this.consume().value;
      }
    }

    if (this.peek().value === '(') {
      variableDefinitions = this.parseVariableDefinitions();
    }

    const selectionSet = this.parseSelectionSet();
    return { kind: 'OperationDefinition', operation, name, variableDefinitions, selectionSet };
  }

  parseVariableDefinitions(): VariableDefinitionNode[] {
    const defs: VariableDefinitionNode[] = [];
    this.expect('(');
    while (this.peek().value !== ')' && this.peek().type !== 'EOF') {
      this.expect('$');
      const varName = this.expect(undefined, 'IDENT').value;
      this.expect(':');
      const typeStr = this.parseTypeString();
      let defaultValue: any = undefined;
      if (this.peek().value === '=') {
        this.consume();
        defaultValue = this.parseValueLiteral();
      }
      defs.push({ kind: 'VariableDefinition', variable: varName, type: typeStr, defaultValue });
      if (this.peek().value === ',') {
        this.consume();
      }
    }
    this.expect(')');
    return defs;
  }

  parseTypeString(): string {
    let typeStr = '';
    if (this.peek().value === '[') {
      this.consume();
      typeStr = '[' + this.parseTypeString() + ']';
      this.expect(']');
    } else {
      typeStr = this.expect(undefined, 'IDENT').value;
    }
    if (this.peek().value === '!') {
      this.consume();
      typeStr += '!';
    }
    return typeStr;
  }

  parseSelectionSet(): SelectionSetNode {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}' && this.peek().type !== 'EOF') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return { kind: 'SelectionSet', selections };
  }

  parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.value === '...') {
      this.consume();
      if (this.peek().type === 'IDENT' && this.peek().value === 'on') {
        this.consume();
        const typeCondition = this.expect(undefined, 'IDENT').value;
        const selectionSet = this.parseSelectionSet();
        return { kind: 'InlineFragment', typeCondition, selectionSet };
      } else if (this.peek().type === 'IDENT') {
        const fragName = this.consume().value;
        return { kind: 'FragmentSpread', name: fragName };
      } else {
        const selectionSet = this.parseSelectionSet();
        return { kind: 'InlineFragment', selectionSet };
      }
    }

    let nameOrAlias = this.expect(undefined, 'IDENT').value;
    let name = nameOrAlias;
    let alias: string | undefined = undefined;

    if (this.peek().value === ':') {
      this.consume();
      alias = nameOrAlias;
      name = this.expect(undefined, 'IDENT').value;
    }

    let args: ArgumentNode[] = [];
    if (this.peek().value === '(') {
      args = this.parseArguments();
    }

    while (this.peek().value === '@') {
      this.consume();
      this.consume();
      if (this.peek().value === '(') {
        this.parseArguments();
      }
    }

    let selectionSet: SelectionSetNode | undefined = undefined;
    if (this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }

    return { kind: 'Field', alias, name, arguments: args, selectionSet };
  }

  parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expect('(');
    while (this.peek().value !== ')' && this.peek().type !== 'EOF') {
      const name = this.expect(undefined, 'IDENT').value;
      this.expect(':');
      const value = this.parseValueLiteral();
      args.push({ kind: 'Argument', name, value });
      if (this.peek().value === ',') {
        this.consume();
      }
    }
    this.expect(')');
    return args;
  }

  parseValueLiteral(): any {
    const t = this.peek();
    if (t.value === '$') {
      this.consume();
      const varName = this.expect(undefined, 'IDENT').value;
      return { kind: 'Variable', name: varName };
    }
    if (t.type === 'STRING') {
      this.consume();
      return t.value;
    }
    if (t.type === 'INT') {
      this.consume();
      return parseInt(t.value, 10);
    }
    if (t.type === 'FLOAT') {
      this.consume();
      return parseFloat(t.value);
    }
    if (t.type === 'IDENT') {
      this.consume();
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { kind: 'EnumValue', value: t.value };
    }
    if (t.value === '[') {
      this.consume();
      const list: any[] = [];
      while (this.peek().value !== ']' && this.peek().type !== 'EOF') {
        list.push(this.parseValueLiteral());
        if (this.peek().value === ',') this.consume();
      }
      this.expect(']');
      return list;
    }
    if (t.value === '{') {
      this.consume();
      const obj: Record<string, any> = {};
      while (this.peek().value !== '}' && this.peek().type !== 'EOF') {
        const key = this.expect(undefined, 'IDENT').value;
        this.expect(':');
        obj[key] = this.parseValueLiteral();
        if (this.peek().value === ',') this.consume();
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`Unexpected token in value literal: ${t.value}`);
  }

  parseFragmentDefinition(): FragmentDefinitionNode {
    this.consume();
    const name = this.expect(undefined, 'IDENT').value;
    this.expect('on');
    const typeCondition = this.expect(undefined, 'IDENT').value;
    const selectionSet = this.parseSelectionSet();
    return { kind: 'FragmentDefinition', name, typeCondition, selectionSet };
  }
}

// ---------------------------------------------------------------- GraphQL Executor

function resolveValue(val: any, variables: Record<string, any>): any {
  if (val && typeof val === 'object' && val.kind === 'Variable') {
    return variables[val.name];
  }
  if (val && typeof val === 'object' && val.kind === 'EnumValue') {
    return val.value;
  }
  if (Array.isArray(val)) {
    return val.map(v => resolveValue(v, variables));
  }
  if (val && typeof val === 'object') {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = resolveValue(v, variables);
    }
    return res;
  }
  return val;
}

function formatPullRequestNode(store: Store, repo: Repository, pr: PullRequest) {
  let state = 'OPEN';
  if (pr.merged) {
    state = 'MERGED';
  } else if (pr.state === 'closed') {
    state = 'CLOSED';
  }

  let mergeable = 'UNKNOWN';
  if (pr.merged) {
    mergeable = 'UNKNOWN';
  } else if (canMergePullRequest(store, repo, pr)) {
    mergeable = 'MERGEABLE';
  } else {
    mergeable = 'CONFLICTING';
  }

  const headRefName = pr.head.startsWith('refs/heads/') ? pr.head.slice('refs/heads/'.length) : pr.head;
  const baseRefName = pr.base.startsWith('refs/heads/') ? pr.base.slice('refs/heads/'.length) : pr.base;

  return {
    __typename: 'PullRequest',
    id: pr.id || makeGlobalId('pull', repo.fullName, pr.number),
    databaseId: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state,
    merged: pr.merged,
    headRefName,
    baseRefName,
    mergeable,
    files: pr.changedFiles || [],
  };
}

function findNode(store: Store, id: string): { type: string; data: any } | null {
  for (const repo of store.repositories.values()) {
    if (makeGlobalId('repository', repo.fullName) === id) {
      return {
        type: 'Repository',
        data: {
          __typename: 'Repository',
          ...repo,
        },
      };
    }
    for (const issue of repo.issues) {
      const issueId = issue.id || makeGlobalId('issue', repo.fullName, issue.number);
      if (issueId === id) {
        return {
          type: 'Issue',
          data: {
            __typename: 'Issue',
            ...issue,
            id: issueId,
            databaseId: issue.number,
            state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
          },
        };
      }
    }
    for (const pr of repo.pullRequests) {
      const prId = pr.id || makeGlobalId('pull', repo.fullName, pr.number);
      if (prId === id) {
        return {
          type: 'PullRequest',
          data: formatPullRequestNode(store, repo, pr),
        };
      }
    }
  }
  return null;
}

function matchesTypeCondition(currentType: string, condition: string): boolean {
  if (currentType === condition) return true;
  if (condition === 'Node') {
    return ['Repository', 'Issue', 'PullRequest'].includes(currentType);
  }
  return false;
}

function getChildType(parentType: string, fieldName: string): string {
  if (parentType === 'Query') {
    if (fieldName === 'viewer' || fieldName === 'owner') return 'User';
    if (fieldName === 'repository') return 'Repository';
    if (fieldName === 'node') return 'Node';
    if (fieldName === '__type') return '__Type';
  }
  if (parentType === 'Repository') {
    if (fieldName === 'owner') return 'User';
    if (fieldName === 'defaultBranchRef') return 'Ref';
    if (fieldName === 'issue') return 'Issue';
    if (fieldName === 'issues') return 'IssueConnection';
    if (fieldName === 'pullRequest') return 'PullRequest';
    if (fieldName === 'pullRequests') return 'PullRequestConnection';
  }
  if (parentType === 'IssueConnection') {
    if (fieldName === 'nodes') return 'Issue';
    if (fieldName === 'pageInfo') return 'PageInfo';
  }
  if (parentType === 'PullRequestConnection') {
    if (fieldName === 'nodes') return 'PullRequest';
    if (fieldName === 'pageInfo') return 'PageInfo';
  }
  if (parentType === 'PullRequest') {
    if (fieldName === 'files') return 'PullRequestChangedFileConnection';
  }
  if (parentType === 'PullRequestChangedFileConnection') {
    if (fieldName === 'nodes') return 'PullRequestChangedFile';
  }
  if (parentType === '__Type') {
    if (fieldName === 'fields') return '__Field';
    if (fieldName === 'enumValues') return '__EnumValue';
  }
  return 'Object';
}

function resolveField(
  store: Store,
  parentObj: any,
  parentType: string,
  fieldName: string,
  args: Record<string, any>,
  variables: Record<string, any>,
  fragments: Record<string, FragmentDefinitionNode>,
  errors: Array<{ message: string; path?: (string | number)[] }>,
  path: (string | number)[]
): any {
  if (fieldName === '__typename') {
    return parentObj.__typename || parentType;
  }

  if (parentType === 'Mutation') {
    if (fieldName === 'createIssue') {
      const input = args['input'] || {};
      const repoId = input['repositoryId'];
      const title = input['title'] || '';
      const body = input['body'] || '';
      let targetRepo: Repository | null = null;
      for (const [_, repo] of store.repositories) {
        if (makeGlobalId('repository', repo.fullName) === repoId) {
          targetRepo = repo;
          break;
        }
      }
      if (!targetRepo) return null;

      const num = targetRepo.nextIssueNumber++;
      const issueId = makeGlobalId('issue', targetRepo.fullName, num);
      const issue: Issue = {
        id: issueId,
        number: num,
        title: typeof title === 'string' ? title : '',
        body: typeof body === 'string' ? body : '',
        state: 'open',
        labels: [],
        comments: [],
      };
      targetRepo.issues.push(issue);

      const issueObj = {
        __typename: 'Issue',
        id: issue.id,
        databaseId: issue.number,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: 'OPEN',
      };
      return {
        __typename: 'CreateIssuePayload',
        issue: issueObj,
        number: issue.number,
        id: issue.id,
        title: issue.title,
        body: issue.body,
        state: 'OPEN',
      };
    }
    if (fieldName === 'closeIssue') {
      const input = args['input'] || {};
      const issueIdArg = input['issueId'];
      let targetIssue: Issue | null = null;
      for (const [_, repo] of store.repositories) {
        for (const issue of repo.issues) {
          const issueId = issue.id || makeGlobalId('issue', repo.fullName, issue.number);
          if (issueId === issueIdArg) {
            targetIssue = issue;
            break;
          }
        }
        if (targetIssue) break;
      }
      if (!targetIssue) return null;

      targetIssue.state = 'closed';

      const issueObj = {
        __typename: 'Issue',
        id: targetIssue.id,
        databaseId: targetIssue.number,
        number: targetIssue.number,
        title: targetIssue.title,
        body: targetIssue.body,
        state: 'CLOSED',
      };
      return {
        __typename: 'CloseIssuePayload',
        issue: issueObj,
        number: targetIssue.number,
        id: targetIssue.id,
        state: 'CLOSED',
      };
    }

    if (fieldName === 'addComment') {
      const input = args['input'] || {};
      const subjectId = input['subjectId'];
      const body = input['body'] || '';
      let targetIssue: Issue | null = null;
      let targetRepo: Repository | null = null;
      for (const [_, repo] of store.repositories) {
        for (const issue of repo.issues) {
          const issueId = issue.id || makeGlobalId('issue', repo.fullName, issue.number);
          if (issueId === subjectId) {
            targetIssue = issue;
            targetRepo = repo;
            break;
          }
        }
        if (targetIssue) break;
      }
      if (!targetIssue || !targetRepo) return null;

      const commentNum = targetRepo.nextCommentId++;
      const commentId = makeGlobalId('comment', targetIssue.id, commentNum);
      const comment: Comment = {
        id: commentNum,
        body: typeof body === 'string' ? body : '',
      };
      targetIssue.comments.push(comment);

      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          node: {
            id: commentId,
            body: comment.body,
          },
        },
      };
    }
    if (fieldName === 'mergePullRequest') {
      const input = args['input'] || {};
      const prIdArg = input['pullRequestId'];
      const mergeMethod = input['mergeMethod'];
      if (mergeMethod && mergeMethod !== 'SQUASH') {
        return null;
      }
      let targetRepo: Repository | null = null;
      let targetPr: PullRequest | null = null;
      for (const [_, repo] of store.repositories) {
        for (const pr of repo.pullRequests) {
          const prId = pr.id || makeGlobalId('pull', repo.fullName, pr.number);
          if (prId === prIdArg) {
            targetRepo = repo;
            targetPr = pr;
            break;
          }
        }
        if (targetPr) break;
      }
      if (!targetRepo || !targetPr) return null;

      if (!canMergePullRequest(store, targetRepo, targetPr)) {
        return null;
      }

      const commitMsg = input['commitMessage'] || input['commitTitle'];
      squashMergePullRequest(store, targetRepo, targetPr, commitMsg);

      const prObj = formatPullRequestNode(store, targetRepo, targetPr);
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: prObj,
        clientMutationId: input['clientMutationId'],
      };
    }
    if (fieldName === 'createPullRequest') {
      const input = args['input'] || {};
      const repoId = input['repositoryId'];
      const title = input['title'] || '';
      const body = input['body'] || '';
      const baseRefName = typeof input['baseRefName'] === 'string' ? input['baseRefName'] : '';
      const headRefName = typeof input['headRefName'] === 'string' ? input['headRefName'] : '';
      let targetRepo: Repository | null = null;
      for (const [_, repo] of store.repositories) {
        if (makeGlobalId('repository', repo.fullName) === repoId) {
          targetRepo = repo;
          break;
        }
      }
      if (!targetRepo) return null;

      const num = targetRepo.nextIssueNumber++;
      const prId = makeGlobalId('pull', targetRepo.fullName, num);
      const headCommitId = resolveRef(store, targetRepo, `refs/heads/${headRefName}`) ?? '';
      const baseCommitId = resolveRef(store, targetRepo, `refs/heads/${baseRefName}`) ?? '';
      const pr: PullRequest = {
        id: prId,
        number: num,
        title: typeof title === 'string' ? title : '',
        body: typeof body === 'string' ? body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitId: null,
        head: headRefName,
        base: baseRefName,
        headCommitId: headCommitId,
        baseCommitId: baseCommitId,
        changedFiles: [],
      };
      targetRepo.pullRequests.push(pr);

      const prObj = formatPullRequestNode(store, targetRepo, pr);
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: prObj,
      };
    }
    errors.push({ message: `Field '${fieldName}' not found on type 'Mutation'`, path });
    return null;
  }

  if (parentType === 'Query') {
    if (fieldName === 'viewer') {
      return { __typename: 'User', login: viewerLogin };
    }
    if (fieldName === 'repository') {
      const owner = args['owner'];
      const name = args['name'];
      if (!owner || !name) return null;
      const repo = getRepository(store, owner, name);
      if (!repo) return null;
      return repo;
    }
    if (fieldName === 'node') {
      const id = args['id'];
      if (!id) return null;
      const found = findNode(store, id);
      return found ? found.data : null;
    }
    if (fieldName === '__type') {
      const typeName = args['name'];
      if (!typeName) return null;

      const isEnum = [
        'IssueState',
        'PullRequestState',
        'MergeableState',
        'RepositoryPermission',
        'SearchType',
        'IssueOrderField',
        'OrderDirection',
        'PullRequestMergeMethod',
      ].includes(typeName);

      let kind = isEnum ? 'ENUM' : 'OBJECT';
      let fields: Array<{ name: string }> = [];
      let enumValues: Array<{ name: string }> = [];

      if (typeName === 'Query') {
        fields = [{ name: 'viewer' }, { name: 'repository' }, { name: 'node' }, { name: '__type' }];
      } else if (typeName === 'Repository') {
        fields = [
          { name: 'id' },
          { name: 'databaseId' },
          { name: 'name' },
          { name: 'nameWithOwner' },
          { name: 'owner' },
          { name: 'defaultBranchRef' },
          { name: 'viewerPermission' },
          { name: 'hasIssuesEnabled' },
          { name: 'issue' },
          { name: 'issues' },
          { name: 'pullRequests' },
          { name: 'pullRequest' },
        ];
      } else if (typeName === 'Issue') {
        fields = [
          { name: 'id' },
          { name: 'number' },
          { name: 'title' },
          { name: 'state' },
          { name: 'body' },
        ];
      } else if (typeName === 'PullRequest') {
        fields = [
          { name: 'id' },
          { name: 'number' },
          { name: 'headRefName' },
          { name: 'baseRefName' },
          { name: 'mergeable' },
          { name: 'state' },
          { name: 'merged' },
          { name: 'files' },
        ];
      } else if (typeName === 'User') {
        fields = [{ name: 'login' }];
      } else if (typeName === 'IssueConnection') {
        fields = [{ name: 'nodes' }, { name: 'pageInfo' }];
      } else if (typeName === 'PullRequestConnection') {
        fields = [{ name: 'nodes' }, { name: 'pageInfo' }];
      } else if (typeName === 'IssueState') {
        enumValues = [{ name: 'OPEN' }, { name: 'CLOSED' }];
      } else if (typeName === 'PullRequestState') {
        enumValues = [{ name: 'OPEN' }, { name: 'CLOSED' }, { name: 'MERGED' }];
      } else if (typeName === 'MergeableState') {
        enumValues = [{ name: 'MERGEABLE' }, { name: 'CONFLICTING' }, { name: 'UNKNOWN' }];
      } else if (typeName === 'RepositoryPermission') {
        enumValues = [{ name: 'ADMIN' }, { name: 'WRITE' }, { name: 'READ' }];
      } else if (typeName === 'SearchType') {
        enumValues = [{ name: 'ISSUE' }, { name: 'REPOSITORY' }];
      } else if (typeName === 'IssueOrderField') {
        enumValues = [{ name: 'CREATED_AT' }];
      } else if (typeName === 'OrderDirection') {
        enumValues = [{ name: 'ASC' }, { name: 'DESC' }];
      } else if (typeName === 'PullRequestMergeMethod') {
        enumValues = [{ name: 'MERGE' }, { name: 'SQUASH' }, { name: 'REBASE' }];
      } else {
        fields = [{ name: 'id' }, { name: 'name' }];
      }

      return {
        __typename: '__Type',
        name: typeName,
        kind,
        fields: fields.map(f => ({ __typename: '__Field', name: f.name })),
        enumValues: enumValues.map(e => ({ __typename: '__EnumValue', name: e.name })),
      };
    }
    errors.push({ message: `Field '${fieldName}' not found on type 'Query'`, path });
    return null;
  }

  if (parentType === 'Repository') {
    const repo: Repository = parentObj;
    if (fieldName === 'id') {
      return makeGlobalId('repository', repo.fullName);
    }
    if (fieldName === 'databaseId') {
      return repo.id;
    }
    if (fieldName === 'name') {
      return repo.name;
    }
    if (fieldName === 'nameWithOwner') {
      return repo.fullName;
    }
    if (fieldName === 'owner') {
      return { __typename: 'User', login: repo.owner };
    }
    if (fieldName === 'defaultBranchRef') {
      return repo.defaultBranch ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    }
    if (fieldName === 'viewerPermission') {
      return 'ADMIN';
    }
    if (fieldName === 'hasIssuesEnabled') {
      return true;
    }
    if (fieldName === 'issue') {
      const num = args['number'];
      if (typeof num !== 'number') return null;
      const issue = repo.issues.find(i => i.number === num);
      if (!issue) return null;
      return {
        __typename: 'Issue',
        id: issue.id || makeGlobalId('issue', repo.fullName, issue.number),
        databaseId: issue.number,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
      };
    }
    if (fieldName === 'issues') {
      let filtered = [...repo.issues];
      const statesArg = args['states'];
      if (Array.isArray(statesArg) && statesArg.length > 0) {
        const lowerStates = statesArg.map((s: string) => s.toLowerCase());
        filtered = filtered.filter(i => lowerStates.includes(i.state));
      }
      const orderByArg = args['orderBy'];
      filtered.sort((a, b) => a.number - b.number);
      if (orderByArg && orderByArg.field === 'CREATED_AT') {
        const direction = (orderByArg.direction || 'ASC').toUpperCase();
        if (direction === 'DESC') {
          filtered.sort((a, b) => b.number - a.number);
        }
      }

      const indexedItems = filtered.map((item, idx) => ({ item, originalIndex: idx }));
      let startPos = 0;
      const afterArg = args['after'];
      if (typeof afterArg === 'string' && afterArg.length > 0) {
        try {
          const decoded = parseInt(Buffer.from(afterArg, 'base64').toString('utf-8'), 10);
          if (!isNaN(decoded)) {
            startPos = decoded + 1;
          }
        } catch {}
      }
      const sliceItems = indexedItems.slice(startPos);
      const first = typeof args['first'] === 'number' ? args['first'] : sliceItems.length;
      const pageItems = sliceItems.slice(0, first);

      const nodes = pageItems.map(({ item }) => ({
        __typename: 'Issue',
        id: item.id || makeGlobalId('issue', repo.fullName, item.number),
        databaseId: item.number,
        number: item.number,
        title: item.title,
        body: item.body,
        state: item.state === 'closed' ? 'CLOSED' : 'OPEN',
      }));

      const hasNextPage = startPos + pageItems.length < indexedItems.length;
      const endCursor = pageItems.length > 0
        ? Buffer.from(String(pageItems[pageItems.length - 1].originalIndex)).toString('base64')
        : (indexedItems.length > 0 ? Buffer.from('0').toString('base64') : '');

      return {
        __typename: 'IssueConnection',
        nodes,
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage,
          endCursor,
        },
      };
    }
    if (fieldName === 'pullRequests') {
      const prs = [...repo.pullRequests].sort((a, b) => a.number - b.number);
      const first = typeof args['first'] === 'number' ? args['first'] : prs.length;
      const nodes = prs.slice(0, first).map(pr => formatPullRequestNode(store, repo, pr));
      return {
        __typename: 'PullRequestConnection',
        nodes,
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: false,
          endCursor: nodes.length > 0 ? Buffer.from(String(nodes.length - 1)).toString('base64') : '',
        },
      };
    }
    if (fieldName === 'pullRequest') {
      const num = args['number'];
      if (typeof num !== 'number') return null;
      const pr = repo.pullRequests.find(p => p.number === num);
      if (!pr) return null;
      return formatPullRequestNode(store, repo, pr);
    }
    errors.push({ message: `Field '${fieldName}' not found on type 'Repository'`, path });
    return null;
  }

  if (parentType === 'User') {
    if (fieldName === 'login') {
      return parentObj.login;
    }
    errors.push({ message: `Field '${fieldName}' not found on type 'User'`, path });
    return null;
  }

  if (parentType === 'Ref') {
    if (fieldName === 'name') {
      return parentObj.name;
    }
    errors.push({ message: `Field '${fieldName}' not found on type 'Ref'`, path });
    return null;
  }

  if (parentType === 'Issue') {
    if (fieldName === 'id') return parentObj.id;
    if (fieldName === 'databaseId') return parentObj.databaseId;
    if (fieldName === 'number') return parentObj.number;
    if (fieldName === 'title') return parentObj.title;
    if (fieldName === 'body') return parentObj.body;
    if (fieldName === 'state') return parentObj.state;
    errors.push({ message: `Field '${fieldName}' not found on type 'Issue'`, path });
    return null;
  }

  if (parentType === 'PullRequest') {
    if (fieldName === 'id') return parentObj.id;
    if (fieldName === 'databaseId') return parentObj.databaseId;
    if (fieldName === 'number') return parentObj.number;
    if (fieldName === 'title') return parentObj.title;
    if (fieldName === 'body') return parentObj.body;
    if (fieldName === 'state') return parentObj.state;
    if (fieldName === 'merged') return parentObj.merged;
    if (fieldName === 'headRefName') return parentObj.headRefName;
    if (fieldName === 'baseRefName') return parentObj.baseRefName;
    if (fieldName === 'mergeable') return parentObj.mergeable;
    if (fieldName === 'files') {
      const filesList = parentObj.files || [];
      const first = typeof args['first'] === 'number' ? args['first'] : filesList.length;
      const slice = filesList.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: slice.map((f: any) => ({
          __typename: 'PullRequestChangedFile',
          path: typeof f === 'string' ? f : (f.filename || f.path),
        })),
      };
    }
    errors.push({ message: `Field '${fieldName}' not found on type 'PullRequest'`, path });
    return null;
  }

  if (parentType === '__Type') {
    if (fieldName === 'name') return parentObj.name;
    if (fieldName === 'kind') return parentObj.kind;
    if (fieldName === 'fields') return parentObj.fields || [];
    if (fieldName === 'enumValues') return parentObj.enumValues || [];
    errors.push({ message: `Field '${fieldName}' not found on type '__Type'`, path });
    return null;
  }

  if (parentType === '__Field') {
    if (fieldName === 'name') return parentObj.name;
    errors.push({ message: `Field '${fieldName}' not found on type '__Field'`, path });
    return null;
  }

  if (parentType === '__EnumValue') {
    if (fieldName === 'name') return parentObj.name;
    errors.push({ message: `Field '${fieldName}' not found on type '__EnumValue'`, path });
    return null;
  }

  if (parentType === 'PageInfo') {
    if (fieldName === 'hasNextPage') return parentObj.hasNextPage;
    if (fieldName === 'endCursor') return parentObj.endCursor;
    errors.push({ message: `Field '${fieldName}' not found on type 'PageInfo'`, path });
    return null;
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection') {
    if (fieldName === 'nodes') return parentObj.nodes || [];
    if (fieldName === 'pageInfo') return parentObj.pageInfo || { __typename: 'PageInfo', hasNextPage: false, endCursor: '' };
    errors.push({ message: `Field '${fieldName}' not found on type '${parentType}'`, path });
    return null;
  }

  if (parentType === 'PullRequestChangedFileConnection') {
    if (fieldName === 'nodes') return parentObj.nodes || [];
    errors.push({ message: `Field '${fieldName}' not found on type 'PullRequestChangedFileConnection'`, path });
    return null;
  }

  if (parentType === 'PullRequestChangedFile') {
    if (fieldName === 'path') return parentObj.path;
    errors.push({ message: `Field '${fieldName}' not found on type 'PullRequestChangedFile'`, path });
    return null;
  }

  if (parentObj && typeof parentObj === 'object' && fieldName in parentObj) {
    return parentObj[fieldName];
  }
  errors.push({ message: `Field '${fieldName}' not found on type '${parentType}'`, path });
  return null;
}

function executeSelectionSet(
  store: Store,
  selectionSet: SelectionSetNode,
  parentObj: any,
  parentType: string,
  variables: Record<string, any>,
  fragments: Record<string, FragmentDefinitionNode>,
  errors: Array<{ message: string; path?: (string | number)[] }>,
  path: (string | number)[]
): any {
  const result: Record<string, any> = {};

  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field') {
      const fieldName = sel.name;
      const alias = sel.alias || fieldName;
      const args: Record<string, any> = {};
      for (const arg of sel.arguments) {
        args[arg.name] = resolveValue(arg.value, variables);
      }
      const fieldPath = [...path, alias];

      try {
        const val = resolveField(store, parentObj, parentType, fieldName, args, variables, fragments, errors, fieldPath);
        if (sel.selectionSet && val !== null && val !== undefined) {
          if (Array.isArray(val)) {
            result[alias] = val.map((item, idx) => {
              if (item && typeof item === 'object') {
                return executeSelectionSet(store, sel.selectionSet!, item, item.__typename || 'Object', variables, fragments, errors, [...fieldPath, idx]);
              }
              return item;
            });
          } else {
            const childType = val.__typename || getChildType(parentType, fieldName);
            result[alias] = executeSelectionSet(store, sel.selectionSet, val, childType, variables, fragments, errors, fieldPath);
          }
        } else {
          result[alias] = val;
        }
      } catch (err: any) {
        errors.push({ message: err.message || String(err), path: fieldPath });
        result[alias] = null;
      }
    } else if (sel.kind === 'InlineFragment') {
      if (!sel.typeCondition || matchesTypeCondition(parentType, sel.typeCondition)) {
        const subResult = executeSelectionSet(store, sel.selectionSet, parentObj, parentType, variables, fragments, errors, path);
        Object.assign(result, subResult);
      }
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments[sel.name];
      if (frag && matchesTypeCondition(parentType, frag.typeCondition)) {
        const subResult = executeSelectionSet(store, frag.selectionSet, parentObj, parentType, variables, fragments, errors, path);
        Object.assign(result, subResult);
      }
    }
  }

  return result;
}

export function executeGraphQL(
  store: Store,
  queryStr: string,
  variablesInput: Record<string, any> = {},
  operationName?: string
): { data: any; errors?: any[] } {
  const tokens = tokenize(queryStr);
  const parser = new Parser(tokens);
  const doc = parser.parseDocument();

  let op: OperationDefinitionNode | undefined = undefined;
  const fragments: Record<string, FragmentDefinitionNode> = {};

  for (const def of doc.definitions) {
    if (def.kind === 'FragmentDefinition') {
      fragments[def.name] = def;
    } else if (def.kind === 'OperationDefinition') {
      if (!op) {
        op = def;
      }
      if (operationName && def.name === operationName) {
        op = def;
      }
    }
  }

  if (!op) {
    return { data: null, errors: [{ message: 'No operation found' }] };
  }

  const variables: Record<string, any> = { ...(variablesInput || {}) };
  for (const vd of op.variableDefinitions) {
    if (variables[vd.variable] === undefined && vd.defaultValue !== undefined) {
      variables[vd.variable] = resolveValue(vd.defaultValue, {});
    }
  }

  const errors: Array<{ message: string; path?: (string | number)[] }> = [];
  const opType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const rootValue = { __typename: opType };
  const data = executeSelectionSet(store, op.selectionSet, rootValue, opType, variables, fragments, errors, []);

  const result: any = { data };
  if (errors.length > 0) {
    result.errors = errors;
  }
  return result;
}

// ---------------------------------------------------------------- Request Handler

let requestIdCounter = 1;

export interface GraphQLResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function handleGraphQL(
  store: Store,
  headers: Record<string, string>,
  body: Buffer | null
): GraphQLResponse {
  const reqId = `req-${requestIdCounter++}`;
  const responseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': reqId,
  };

  let authHeader: string | null = null;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      authHeader = v;
      break;
    }
  }

  if (!isAuthenticated(authHeader)) {
    return {
      status: 401,
      headers: responseHeaders,
      body: JSON.stringify({ message: 'Requires authentication' }),
    };
  }

  if (!body || body.length === 0) {
    return {
      status: 400,
      headers: responseHeaders,
      body: JSON.stringify({ message: 'Missing request body' }),
    };
  }

  let jsonBody: any;
  try {
    jsonBody = JSON.parse(body.toString('utf-8'));
  } catch {
    return {
      status: 400,
      headers: responseHeaders,
      body: JSON.stringify({ message: 'Invalid JSON' }),
    };
  }

  if (Array.isArray(jsonBody)) {
    const results = jsonBody.map(op => {
      const query = op.query;
      const variables = op.variables || {};
      const operationName = op.operationName;
      if (!query || typeof query !== 'string') {
        return { data: null, errors: [{ message: 'Missing query' }] };
      }
      return executeGraphQL(store, query, variables, operationName);
    });
    return {
      status: 200,
      headers: responseHeaders,
      body: JSON.stringify(results),
    };
  } else {
    const query = jsonBody.query;
    const variables = jsonBody.variables || {};
    const operationName = jsonBody.operationName;
    if (!query || typeof query !== 'string') {
      return {
        status: 200,
        headers: responseHeaders,
        body: JSON.stringify({ data: null, errors: [{ message: 'Missing query' }] }),
      };
    }
    const result = executeGraphQL(store, query, variables, operationName);
    return {
      status: 200,
      headers: responseHeaders,
      body: JSON.stringify(result),
    };
  }
}
