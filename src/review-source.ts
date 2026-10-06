import type { ExtensionDiffFile } from "hunkdiff/extension";

// Transforms have no ReviewStore snapshot. This is an ephemeral reuse guard for
// an already command-validated order, not a content identity or persisted digest.
export function sameLoadedSource(left: readonly ExtensionDiffFile[], right: readonly ExtensionDiffFile[]): boolean {
  if (left.length !== right.length) return false;
  const previous = new Map(left.map((file) => [file.path, file]));
  if (previous.size !== left.length) return false;
  const seen = new Set<string>();
  return right.every((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    const old = previous.get(file.path);
    return old && old.patch === file.patch && old.previousPath === file.previousPath &&
      old.stats.additions === file.stats.additions && old.stats.deletions === file.stats.deletions &&
      Boolean(old.isBinary) === Boolean(file.isBinary) && Boolean(old.isTooLarge) === Boolean(file.isTooLarge) &&
      Boolean(old.isUntracked) === Boolean(file.isUntracked);
  });
}
