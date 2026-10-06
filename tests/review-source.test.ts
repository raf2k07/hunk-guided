import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { sameLoadedSource } from "../src/review-source.ts";

const files: ExtensionDiffFile[] = ["a.ts", "b.ts"].map((path) => ({
  id: path, path, patch: `+${path}`, stats: { additions: 1, deletions: 0 }, metadata: {}, agent: null,
}));
it("reuses a validated order across reordering without relying on runtime IDs or metadata", () => {
  assert.ok(sameLoadedSource(files, [...files].reverse().map((file) => ({ ...file, id: "new-runtime-id", metadata: {} }))));
});
it("never reuses validated ordering for changed source, paths, stats, or flags", () => {
  for (const change of [{ patch: "+changed" }, { path: "renamed.ts" }, { previousPath: "old.ts" },
    { stats: { additions: 2, deletions: 0 } }, { isBinary: true }, { isTooLarge: true }, { isUntracked: true }]) {
    assert.equal(sameLoadedSource(files, [{ ...files[0], ...change }, files[1]]), false);
  }
  assert.equal(sameLoadedSource(files, files.slice(1)), false);
});
it("refuses ambiguous duplicate paths on either side", () => {
  assert.equal(sameLoadedSource(files, [files[0], files[0]]), false);
  assert.equal(sameLoadedSource([files[0], files[0]], files), false);
});
