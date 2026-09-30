// The manifest / snapshot / lock helpers live in hook/snapshot.js so the hook and the extension share a
// single implementation (the hook must be a self-contained file). esbuild bundles it into the extension.
export * from '../../hook/snapshot';
export type { Manifest, ManifestEntry, ReviewPaths } from '../../hook/snapshot';
