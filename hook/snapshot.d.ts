// Type declarations for hook/snapshot.js (shared by the hook, the extension and the tests).

export interface ManifestEntry {
  /** Absolute path with forward slashes. */
  path: string;
  /** File name inside originals/, or null when the file did not exist before Claude created it. */
  snapshot: string | null;
  isNew: boolean;
  timestamp: number;
}

export interface Manifest {
  version: number;
  files: ManifestEntry[];
}

export interface ReviewPaths {
  dir: string;
  manifest: string;
  originals: string;
  lock: string;
  log: string;
}

export interface RecordResult {
  result: 'added' | 'exists' | 'ignored';
  reason?: string;
  path?: string;
  entry?: ManifestEntry;
}

export interface RecordOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  cwd?: string;
}

export const REVIEW_DIR: string;
export const MANIFEST_VERSION: number;
export function normalizePath(p: string, platform?: NodeJS.Platform, base?: string): string;
export function pathKey(p: string, platform?: NodeJS.Platform): string;
export function samePath(a: string, b: string, platform?: NodeJS.Platform): boolean;
export function isInside(child: string, parent: string, platform?: NodeJS.Platform): boolean;
export function snapshotName(filePath: string, platform?: NodeJS.Platform): string;
export function reviewPaths(root: string): ReviewPaths;
export function log(root: string, level: string, message: string): void;
export function withLock<T>(root: string, fn: () => Promise<T> | T, timeoutMs?: number): Promise<T>;
export function withLockSync<T>(root: string, fn: () => T, timeoutMs?: number): T;
export function readManifest(root: string): { manifest: Manifest; warning?: string };
export function writeFileAtomic(target: string, data: string | Uint8Array): void;
export function writeManifestAtomic(root: string, manifest: Manifest): void;
export function findEntry(manifest: Manifest, filePath: string, platform?: NodeJS.Platform): ManifestEntry | undefined;
export function eligiblePath(
  root: string,
  filePath: unknown,
  platform?: NodeJS.Platform,
  cwd?: string,
): { path?: string; reason?: string };
export function recordSnapshot(root: string, filePath: unknown, opts?: RecordOptions): RecordResult;
export function filePathFromInput(input: unknown): string | undefined;
export function resolveRoot(scriptPath: string, env: Record<string, string | undefined>, input: unknown): string | undefined;
export function handleHookInput(input: unknown, root: string, opts?: RecordOptions): RecordResult;
export function emptyManifest(): Manifest;
