import { createHash } from 'node:crypto';
import {
  hashObjectId,
  parseTree,
  buildTree,
  parseCommit,
  buildCommit,
  getReachableIds,
  type TreeEntry,
} from './gitlib.ts';

// ---------------------------------------------------------------- User Generation & Identity (ported from wire.ts)

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const U64_MASK = 0xffffffffffffffffn;

export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }

  clone(): Rng {
    return new Rng(this.#state);
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    }
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }
}

const FIRST_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const LAST_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push(Object.freeze({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` }));
  }
  return users;
}

const scenarioUsers = generateUsers(Rng.fromLabel('users'), 12);
export const viewer: ScenarioUser = scenarioUsers[0];
export const viewerLogin: string = viewer.login;
export const viewerName: string = viewer.name;
export const viewerEmail: string = viewer.email;
export const viewerId: number = viewer.id;
export const strangerLogin: string = scenarioUsers[2].login;

export const bearerToken: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function isAuthenticated(authHeader?: string | null): boolean {
  if (bearerToken === '') return true;
  if (!authHeader) return false;
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1] === bearerToken;
  }
  return authHeader === bearerToken;
}

// ---------------------------------------------------------------- Store Data Structures

export interface GitObjectEntry {
  type: string;
  raw: Uint8Array;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitId: string | null;
  head: string;
  base: string;
  headCommitId: string;
  baseCommitId: string;
  changedFiles: ChangedFile[];
}

export interface Label {
  name: string;
  color: string;
}

export interface Repository {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pullRequests: PullRequest[];
  nextIssueNumber: number;
  nextCommentId: number;
}

export interface Store {
  objects: Map<string, GitObjectEntry>;
  repositories: Map<string, Repository>;
  nextRepoId: number;
}

export function createStore(): Store {
  return {
    objects: new Map<string, GitObjectEntry>(),
    repositories: new Map<string, Repository>(),
    nextRepoId: 1,
  };
}

// ---------------------------------------------------------------- Global ID Helper

function makeGlobalId(prefix: string, ...parts: (string | number)[]): string {
  const content = `${prefix}:${parts.join(':')}`;
  return createHash('sha1').update(content).digest('hex');
}

export { makeGlobalId };

// ---------------------------------------------------------------- Repository Helpers

export function createRepository(
  store: Store,
  name: string,
  description = '',
  privateFlag = false
): Repository | null {
  const key = `${viewerLogin}/${name}`;
  if (store.repositories.has(key)) {
    return null;
  }
  const repo: Repository = {
    id: store.nextRepoId++,
    name,
    owner: viewerLogin,
    fullName: key,
    description,
    private: privateFlag,
    defaultBranch: 'main',
    refs: new Map<string, string>(),
    labels: new Map<string, Label>(),
    issues: [],
    pullRequests: [],
    nextIssueNumber: 1,
    nextCommentId: 1,
  };
  store.repositories.set(key, repo);
  return repo;
}

export function getRepository(store: Store, owner: string, name: string): Repository | null {
  if (owner !== viewerLogin) return null;
  const key = `${owner}/${name}`;
  return store.repositories.get(key) ?? null;
}

export function listViewerRepositories(store: Store): Repository[] {
  const list: Repository[] = [];
  for (const repo of store.repositories.values()) {
    if (repo.owner === viewerLogin) {
      list.push(repo);
    }
  }
  list.sort((a, b) => a.id - b.id);
  return list;
}

export function deleteRepository(store: Store, owner: string, name: string): boolean {
  if (owner !== viewerLogin) return false;
  const key = `${owner}/${name}`;
  return store.repositories.delete(key);
}

// ---------------------------------------------------------------- Git-Object and Ref Helpers

export function putObject(store: Store, type: string, raw: Uint8Array, id?: string): string {
  const objectId = id ?? hashObjectId(type, raw);
  store.objects.set(objectId, { type, raw });
  return objectId;
}

export function getObject(store: Store, id: string): GitObjectEntry | null {
  return store.objects.get(id) ?? null;
}

export function resolveRef(store: Store, repo: Repository, refName: string): string | null {
  if (repo.refs.has(refName)) {
    return repo.refs.get(refName)!;
  }
  const candidates = [
    refName,
    `refs/heads/${refName}`,
    `refs/tags/${refName}`,
    `refs/remotes/origin/${refName}`,
  ];
  for (const c of candidates) {
    if (repo.refs.has(c)) {
      return repo.refs.get(c)!;
    }
  }
  if (/^[0-9a-f]{40}$/.test(refName)) {
    if (store.objects.has(refName)) {
      return refName;
    }
  }
  return null;
}

export function setRef(store: Store, repo: Repository, refName: string, commitId: string): void {
  const fullName = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
  repo.refs.set(fullName, commitId);
}

export function deleteRef(store: Store, repo: Repository, refName: string): void {
  repo.refs.delete(refName);
  repo.refs.delete(`refs/heads/${refName}`);
  repo.refs.delete(`refs/tags/${refName}`);
}

export function listRefs(store: Store, repo: Repository): Array<{ name: string; oid: string }> {
  const result: Array<{ name: string; oid: string }> = [];
  const sortedKeys = Array.from(repo.refs.keys()).sort();
  const seen = new Set<string>();
  for (const name of sortedKeys) {
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({ name, oid: repo.refs.get(name)! });
  }
  return result;
}

export function walkReachability(store: Store, tips: string[]): Set<string> {
  return getReachableIds(tips, (id) => store.objects.get(id));
}

export function isAncestor(store: Store, ancestorId: string, descendantId: string): boolean {
  if (ancestorId === descendantId) return true;
  const visited = new Set<string>();
  const queue = [descendantId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === ancestorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const obj = store.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.raw);
    for (const p of commit.parents) {
      if (!visited.has(p)) {
        queue.push(p);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- Tree & Commit Helpers

function countLines(bytes: Uint8Array): { additions: number; deletions: number; changes: number } {
  if (bytes.length === 0) return { additions: 0, deletions: 0, changes: 0 };
  let lines = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) lines++;
  }
  if (bytes[bytes.length - 1] !== 10) lines++;
  return { additions: lines, deletions: 0, changes: lines };
}

export function commitFile(
  store: Store,
  repo: Repository,
  branchName: string,
  filePath: string,
  newBytes: Uint8Array | null,
  message: string
): { commitId: string; blobId: string | null } {
  const refName = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`;
  const tipCommitId = resolveRef(store, repo, refName);

  let currentTreeId: string | null = null;
  if (tipCommitId) {
    const tipCommitObj = store.objects.get(tipCommitId);
    if (tipCommitObj && tipCommitObj.type === 'commit') {
      const commitData = parseCommit(tipCommitObj.raw);
      currentTreeId = commitData.tree;
    }
  }

  let blobId: string | null = null;
  if (newBytes !== null) {
    blobId = putObject(store, 'blob', newBytes);
  }

  const segments = filePath.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`Invalid file path: ${filePath}`);
  }

  // Recursive tree builder
  function buildTreeRecursive(treeId: string | null, segIndex: number): string {
    const entries: TreeEntry[] = [];
    if (treeId) {
      const treeObj = store.objects.get(treeId);
      if (treeObj && treeObj.type === 'tree') {
        entries.push(...parseTree(treeObj.raw));
      }
    }

    const currentSegment = segments[segIndex];
    const isLeaf = segIndex === segments.length - 1;

    const existingIndex = entries.findIndex((e) => e.name === currentSegment);

    if (isLeaf) {
      if (newBytes === null) {
        // Delete
        if (existingIndex !== -1) {
          entries.splice(existingIndex, 1);
        }
      } else {
        // Add or modify
        const newEntry: TreeEntry = {
          mode: '100644',
          name: currentSegment,
          oid: blobId!,
        };
        if (existingIndex !== -1) {
          entries[existingIndex] = newEntry;
        } else {
          entries.push(newEntry);
        }
      }
    } else {
      // Intermediate directory
      let subTreeId: string | null = null;
      if (existingIndex !== -1) {
        subTreeId = entries[existingIndex].oid;
      }
      const newSubTreeId = buildTreeRecursive(subTreeId, segIndex + 1);
      const subTreeEntry: TreeEntry = {
        mode: '40000',
        name: currentSegment,
        oid: newSubTreeId,
      };
      if (existingIndex !== -1) {
        entries[existingIndex] = subTreeEntry;
      } else {
        entries.push(subTreeEntry);
      }
    }

    const builtBytes = buildTree(entries);
    return putObject(store, 'tree', builtBytes);
  }

  const newRootTreeId = buildTreeRecursive(currentTreeId, 0);

  const authorStr = `${viewerName} <${viewerEmail}> 1700000000 +0000`;
  const parents = tipCommitId ? [tipCommitId] : [];
  const commitRaw = buildCommit(newRootTreeId, parents, authorStr, authorStr, message);
  const commitId = putObject(store, 'commit', commitRaw);

  repo.refs.set(refName, commitId);
  if (!branchName.startsWith('refs/')) {
    repo.refs.set(branchName, commitId);
  }

  return { commitId, blobId };
}

export function readFileAtRef(
  store: Store,
  repo: Repository,
  refName: string,
  filePath: string
): { blobId: string; bytes: Uint8Array } | null {
  const commitId = resolveRef(store, repo, refName);
  if (!commitId) return null;
  const commitObj = store.objects.get(commitId);
  if (!commitObj || commitObj.type !== 'commit') return null;
  let treeId = parseCommit(commitObj.raw).tree;

  const segments = filePath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const treeObj = store.objects.get(treeId);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entries = parseTree(treeObj.raw);
    const found = entries.find((e) => e.name === seg);
    if (!found) return null;
    if (i === segments.length - 1) {
      if (found.mode.startsWith('4') || found.mode === '40000') return null;
      const blobObj = store.objects.get(found.oid);
      if (!blobObj || blobObj.type !== 'blob') return null;
      return { blobId: found.oid, bytes: blobObj.raw };
    } else {
      treeId = found.oid;
    }
  }
  return null;
}

export interface DirEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  id: string;
}

export function listDirectoryAtRef(
  store: Store,
  repo: Repository,
  refName: string,
  dirPath: string
): DirEntry[] | null {
  const commitId = resolveRef(store, repo, refName);
  if (!commitId) return null;
  const commitObj = store.objects.get(commitId);
  if (!commitObj || commitObj.type !== 'commit') return null;
  let treeId = parseCommit(commitObj.raw).tree;

  const cleanDir = dirPath.replace(/^\/+|\/+$/g, '');
  const segments = cleanDir === '' ? [] : cleanDir.split('/').filter(Boolean);

  for (const seg of segments) {
    const treeObj = store.objects.get(treeId);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entries = parseTree(treeObj.raw);
    const found = entries.find((e) => e.name === seg);
    if (!found) return null;
    treeId = found.oid;
  }

  const targetTreeObj = store.objects.get(treeId);
  if (!targetTreeObj || targetTreeObj.type !== 'tree') return null;
  const entries = parseTree(targetTreeObj.raw);
  const result: DirEntry[] = [];
  const prefix = cleanDir === '' ? '' : `${cleanDir}/`;

  for (const entry of entries) {
    const isDir = entry.mode.startsWith('4') || entry.mode === '40000';
    result.push({
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: `${prefix}${entry.name}`,
      id: entry.oid,
    });
  }
  return result;
}

// ---------------------------------------------------------------- Diff Helper

export function diffTrees(
  store: Store,
  oldTreeId: string | null,
  newTreeId: string | null
): ChangedFile[] {
  const oldFiles = new Map<string, { oid: string; bytes: Uint8Array }>();
  const newFiles = new Map<string, { oid: string; bytes: Uint8Array }>();

  function collectFiles(treeId: string | null, prefix: string, map: Map<string, { oid: string; bytes: Uint8Array }>) {
    if (!treeId) return;
    const treeObj = store.objects.get(treeId);
    if (!treeObj || treeObj.type !== 'tree') return;
    const entries = parseTree(treeObj.raw);
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const isDir = entry.mode.startsWith('4') || entry.mode === '40000';
      if (isDir) {
        collectFiles(entry.oid, path, map);
      } else {
        const blobObj = store.objects.get(entry.oid);
        map.set(path, { oid: entry.oid, bytes: blobObj ? blobObj.raw : new Uint8Array(0) });
      }
    }
  }

  collectFiles(oldTreeId, '', oldFiles);
  collectFiles(newTreeId, '', newFiles);

  const allPaths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const changed: ChangedFile[] = [];

  for (const path of allPaths) {
    const oldF = oldFiles.get(path);
    const newF = newFiles.get(path);

    if (!oldF && newF) {
      const stats = countLines(newF.bytes);
      changed.push({
        filename: path,
        status: 'added',
        additions: stats.additions,
        deletions: 0,
        changes: stats.additions,
      });
    } else if (oldF && !newF) {
      const stats = countLines(oldF.bytes);
      changed.push({
        filename: path,
        status: 'removed',
        additions: 0,
        deletions: stats.additions,
        changes: stats.additions,
      });
    } else if (oldF && newF && oldF.oid !== newF.oid) {
      const oldStats = countLines(oldF.bytes);
      const newStats = countLines(newF.bytes);
      changed.push({
        filename: path,
        status: 'modified',
        additions: newStats.additions,
        deletions: oldStats.additions,
        changes: newStats.additions + oldStats.additions,
      });
    }
  }

  changed.sort((a, b) => a.filename.localeCompare(b.filename));
  return changed;
}

// ---------------------------------------------------------------- Pull Request Helpers

export function canMergePullRequest(store: Store, repo: Repository, pr: PullRequest): boolean {
  const baseRef = pr.base.startsWith('refs/') ? pr.base : `refs/heads/${pr.base}`;
  const currentBaseTipId = resolveRef(store, repo, baseRef);
  if (!currentBaseTipId) return false;

  // If base branch hasn't moved since PR creation baseCommitId, it can merge cleanly
  if (currentBaseTipId === pr.baseCommitId) return true;

  // Compare files changed in PR vs files changed on base branch between pr.baseCommitId and currentBaseTipId
  const baseCommitObj = store.objects.get(pr.baseCommitId);
  const currentBaseTipObj = store.objects.get(currentBaseTipId);
  if (!baseCommitObj || !currentBaseTipObj) return false;

  const baseTreeId = parseCommit(baseCommitObj.raw).tree;
  const currentBaseTreeId = parseCommit(currentBaseTipObj.raw).tree;

  const baseChanges = diffTrees(store, baseTreeId, currentBaseTreeId);
  const changedPathsOnBase = new Set(baseChanges.map((c) => c.filename));

  for (const prFile of pr.changedFiles) {
    if (changedPathsOnBase.has(prFile.filename)) {
      return false; // Conflict detected on same file
    }
  }

  return true;
}

export function squashMergePullRequest(
  store: Store,
  repo: Repository,
  pr: PullRequest,
  commitMessage?: string
): string {
  const baseRef = pr.base.startsWith('refs/') ? pr.base : `refs/heads/${pr.base}`;
  const currentBaseTipId = resolveRef(store, repo, baseRef);
  if (!currentBaseTipId) {
    throw new Error(`Base branch ${pr.base} not found`);
  }

  const baseTipObj = store.objects.get(currentBaseTipId);
  if (!baseTipObj || baseTipObj.type !== 'commit') {
    throw new Error('Base tip commit invalid');
  }
  const baseTreeId = parseCommit(baseTipObj.raw).tree;

  const headCommitObj = store.objects.get(pr.headCommitId);
  if (!headCommitObj || headCommitObj.type !== 'commit') {
    throw new Error('Head commit invalid');
  }
  const headTreeId = parseCommit(headCommitObj.raw).tree;

  // Build new tree starting from base tree and applying PR changed files from head tree
  // We can collect all files from head tree that were part of PR or just rebuild tree from head tree values for PR changed files.
  // Actually, we can take baseTree, and for each changed file in pr.changedFiles, set its blob from headTree.
  // Let's implement a tree merge helper or use diffTrees / direct file copying.
  
  // A clean way: read each changed file from head tree and commit it into base branch, or construct tree.
  // Since commitFile creates commits, we can iteratively apply pr.changedFiles from head tree onto base branch!
  // Wait, squash merge should produce ONE single commit on base branch.
  // Let's build the tree directly or via commitFile: if we apply all PR changed files (or copy tree entries from head tree for those paths), we get the merged tree.
  
  let mergedTreeId = baseTreeId;
  for (const file of pr.changedFiles) {
    if (file.status === 'removed') {
      mergedTreeId = updateTreePath(store, mergedTreeId, file.filename, null);
    } else {
      // Get blob id from head tree
      const blobId = getBlobIdAtTreePath(store, headTreeId, file.filename);
      if (blobId) {
        const blobObj = store.objects.get(blobId);
        if (blobObj) {
          mergedTreeId = updateTreePath(store, mergedTreeId, file.filename, blobObj.raw);
        }
      }
    }
  }

  const message = commitMessage ?? `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
  const authorStr = `${viewerName} <${viewerEmail}> 1700000000 +0000`;
  const commitRaw = buildCommit(mergedTreeId, [currentBaseTipId], authorStr, authorStr, message);
  const mergeCommitId = putObject(store, 'commit', commitRaw);

  repo.refs.set(baseRef, mergeCommitId);
  if (!pr.base.startsWith('refs/')) {
    repo.refs.set(pr.base, mergeCommitId);
  }

  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = '2026-11-14T06:30:00Z';
  pr.mergeCommitId = mergeCommitId;

  return mergeCommitId;
}

function getBlobIdAtTreePath(store: Store, treeId: string, filePath: string): string | null {
  let currTreeId = treeId;
  const segments = filePath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const treeObj = store.objects.get(currTreeId);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entries = parseTree(treeObj.raw);
    const found = entries.find((e) => e.name === seg);
    if (!found) return null;
    if (i === segments.length - 1) {
      return found.oid;
    } else {
      currTreeId = found.oid;
    }
  }
  return null;
}

function updateTreePath(store: Store, treeId: string | null, filePath: string, newBytes: Uint8Array | null): string {
  let blobId: string | null = null;
  if (newBytes !== null) {
    blobId = putObject(store, 'blob', newBytes);
  }

  const segments = filePath.split('/').filter(Boolean);

  function recurse(currTreeId: string | null, segIndex: number): string {
    const entries: TreeEntry[] = [];
    if (currTreeId) {
      const treeObj = store.objects.get(currTreeId);
      if (treeObj && treeObj.type === 'tree') {
        entries.push(...parseTree(treeObj.raw));
      }
    }

    const seg = segments[segIndex];
    const isLeaf = segIndex === segments.length - 1;
    const existingIndex = entries.findIndex((e) => e.name === seg);

    if (isLeaf) {
      if (newBytes === null) {
        if (existingIndex !== -1) entries.splice(existingIndex, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name: seg, oid: blobId! };
        if (existingIndex !== -1) entries[existingIndex] = entry;
        else entries.push(entry);
      }
    } else {
      let subTreeId: string | null = null;
      if (existingIndex !== -1) subTreeId = entries[existingIndex].oid;
      const newSubTreeId = recurse(subTreeId, segIndex + 1);
      const subEntry: TreeEntry = { mode: '40000', name: seg, oid: newSubTreeId };
      if (existingIndex !== -1) entries[existingIndex] = subEntry;
      else entries.push(subEntry);
    }

    return putObject(store, 'tree', buildTree(entries));
  }

  return recurse(treeId, 0);
}
