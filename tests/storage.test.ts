import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { StaleGuideError, type ReviewContentFile, type ReviewGuide } from "../src/guide.ts";
import { cacheRoot, describeMissingGuide, guideDirectory, guideKey, guidePath, MAX_GUIDE_BYTES, pruneGuides, readGuide, rememberReview, touchGuide } from "../src/storage.ts";
import { utimes, symlink, stat } from "node:fs/promises";

// Every cache function takes its root explicitly: tests pass a throwaway
// directory and never need to change process-wide state.
async function cacheIn(t: TestContext): Promise<{ parent: string; root: string }> {
  const parent = await temporaryDirectory(t);
  return { parent, root: join(parent, "cache") };
}
const DAY = 24 * 60 * 60 * 1000;
async function writeKeyed(directory: string, name: string, ageMs = 0): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, "{}");
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}
const key = (character: string) => character.repeat(32);
const exists = (path: string) => stat(path).then(() => true, () => false);

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hunk-review-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function makeFile(overrides: Partial<ReviewContentFile> = {}): ReviewContentFile {
  const path = overrides.path ?? "src/core.ts";
  return {
    fileKey: `host-file:${path}`,
    contentIdentity: `host-content:${path}:captured`,
    path,
    ...overrides,
  };
}

function makeGuide(files: readonly ReviewContentFile[]): ReviewGuide {
  return {
    schemaVersion: 3,
    reviewKey: guideKey(files),
    summary: "Update the core implementation.",
    sections: [{
      id: "core-changes",
      title: "Core changes",
      summary: "Review the implementation change.",
      files: files.map((file) => file.path),
    }],
  };
}

function assertOutside(checkout: string, path: string): void {
  const fromCheckout = relative(checkout, path);
  assert.ok(
    isAbsolute(fromCheckout) || fromCheckout === ".." || fromCheckout.startsWith(`..${sep}`),
    `${path} must be outside ${checkout}`,
  );
}

describe("readGuide", () => {
  it("returns null for a missing guide, including a missing parent directory", async (t) => {
    const directory = await temporaryDirectory(t);
    assert.equal(await readGuide(join(directory, "guide.json"), [makeFile()]), null);
    assert.equal(await readGuide(join(directory, "missing", "guide.json"), [makeFile()]), null);
  });

  it("reads and validates a valid JSON guide", async (t) => {
    const directory = await temporaryDirectory(t);
    const files = [makeFile(), makeFile({ path: "src/ui.ts" })];
    const guide = makeGuide(files);
    const path = join(directory, "guide.json");
    await writeFile(path, JSON.stringify(guide, null, 2));
    const reordered = Object.freeze([...files].reverse());
    assert.deepEqual(await readGuide(path, reordered), guide);
  });

  it("rejects malformed JSON rather than treating it as a missing guide", async (t) => {
    const directory = await temporaryDirectory(t);
    const path = join(directory, "guide.json");
    await writeFile(path, '{"schemaVersion":');
    await assert.rejects(readGuide(path, [makeFile()]), SyntaxError);
  });

  it("rejects JSON null and invalid guide schemas", async (t) => {
    const directory = await temporaryDirectory(t);
    const path = join(directory, "guide.json");
    await writeFile(path, "null");
    await assert.rejects(readGuide(path, [makeFile()]), /Guide must be an object/);
    for (const schemaVersion of [1, 2, 4]) {
      await writeFile(path, JSON.stringify({ ...makeGuide([makeFile()]), schemaVersion }));
      await assert.rejects(readGuide(path, [makeFile()]), /Unsupported guide schemaVersion/);
    }
  });

  it("preserves StaleGuideError for a guide from different native review content", async (t) => {
    const directory = await temporaryDirectory(t);
    const path = join(directory, "guide.json");
    await writeFile(path, JSON.stringify(makeGuide([makeFile()])));
    await assert.rejects(readGuide(path, [makeFile({ contentIdentity: "host-content:changed" })]), StaleGuideError);
  });

  it("accepts a valid guide exactly at the byte limit", async (t) => {
    const directory = await temporaryDirectory(t);
    const files = [makeFile()];
    const guide = makeGuide(files);
    const json = JSON.stringify(guide);
    const content = json + " ".repeat(MAX_GUIDE_BYTES - Buffer.byteLength(json));
    const path = join(directory, "guide.json");
    assert.equal(Buffer.byteLength(content), MAX_GUIDE_BYTES);
    await writeFile(path, content);
    assert.deepEqual(await readGuide(path, files), guide);
  });

  it("rejects a guide one byte over the limit even when its JSON is valid", async (t) => {
    const directory = await temporaryDirectory(t);
    const files = [makeFile()];
    const json = JSON.stringify(makeGuide(files));
    const path = join(directory, "guide.json");
    await writeFile(path, json + " ".repeat(MAX_GUIDE_BYTES + 1 - Buffer.byteLength(json)));
    await assert.rejects(readGuide(path, files), /regular JSON file no larger than 1 MiB/);
  });

  it("refuses directories", async (t) => {
    const directory = await temporaryDirectory(t);
    await assert.rejects(readGuide(directory, [makeFile()]), (error: unknown) => {
      assert.ok(error instanceof Error);
      // Some platforms reject opening the directory before the regular-file check.
      assert.ok(
        /regular JSON file/.test(error.message) ||
        (error as NodeJS.ErrnoException).code === "EISDIR" ||
        (error as NodeJS.ErrnoException).code === "EPERM",
      );
      return true;
    });
  });
});

describe("guideKey and guidePath", () => {
  const files = [makeFile(), makeFile({ path: "src/ui.ts" })];
  it("is a stable 32-hex name independent of file order and input mutation", () => {
    const frozen = Object.freeze([...files]);
    assert.match(guideKey(frozen), /^[0-9a-f]{32}$/);
    assert.equal(guideKey(frozen), guideKey([...files].reverse()));
    assert.equal(guideKey(files), guideKey(files.map((file) => ({ ...file }))));
  });
  it("changes when any native identity or path changes, or membership changes", () => {
    const original = guideKey(files);
    const variants: ReviewContentFile[][] = [
      [files[0], { ...files[1], contentIdentity: "host-content:other" }],
      [files[0], { ...files[1], fileKey: "host-file:other" }],
      [files[0], { ...files[1], path: "src/renamed.ts" }],
      [files[0]],
      [...files, makeFile({ path: "src/extra.ts" })],
    ];
    for (const variant of variants) assert.notEqual(guideKey(variant), original);
  });
  it("does not confuse field boundaries", () => {
    assert.notEqual(
      guideKey([{ fileKey: "a", contentIdentity: "bc", path: "d" }]),
      guideKey([{ fileKey: "ab", contentIdentity: "c", path: "d" }]),
    );
  });
  it("places the guide directly under the given root, independent of the working directory", async (t) => {
    const { root } = await cacheIn(t);
    const path = guidePath(root, files);
    assert.equal(path, join(root, "guides", `${guideKey(files)}.json`));
    assert.equal(guideDirectory(root), join(root, "guides"));
    assert.ok(isAbsolute(path));
    assertOutside(process.cwd(), path);
    assert.equal(relative(root, path).split(sep).length, 2);
  });
  it("defaults the production root to the home cache without creating it", () => {
    assert.equal(cacheRoot(), join(homedir(), ".cache", "hunk-review-plugin"));
  });
  it("lets a later session find and validate the guide with no stored path", async (t) => {
    const { root } = await cacheIn(t);
    const guide = makeGuide(files);
    await mkdir(guideDirectory(root), { recursive: true });
    await writeFile(guidePath(root, files), JSON.stringify(guide));
    const reordered = [...files].reverse();
    assert.deepEqual(await readGuide(guidePath(root, reordered), reordered), guide);
  });
});

describe("describeMissingGuide", () => {
  const files = [makeFile()];
  const changed = [makeFile({ contentIdentity: "host-content:changed" })];
  it("reports a plain missing guide when no earlier review is recorded", async (t) => {
    const { root } = await cacheIn(t);
    const result = await describeMissingGuide(root, "/work/repo", files);
    assert.equal(result.stale, false);
    assert.match(result.message, /No guide for this review yet/);
  });
  it("stays non-stale when the recorded review is the current one", async (t) => {
    const { root } = await cacheIn(t);
    await rememberReview(root, "/work/repo", files);
    assert.equal((await describeMissingGuide(root, "/work/repo", files)).stale, false);
  });
  it("reports a stale guide when the recorded review changed and its guide exists", async (t) => {
    const { root } = await cacheIn(t);
    await rememberReview(root, "/work/repo", files);
    await mkdir(guideDirectory(root), { recursive: true });
    await writeFile(guidePath(root, files), "{}");
    const result = await describeMissingGuide(root, "/work/repo", changed);
    assert.equal(result.stale, true);
    assert.match(result.message, /Guide is out of date.*earlier version/);
  });
  it("reports a changed review when the earlier guide was never written", async (t) => {
    const { root } = await cacheIn(t);
    await rememberReview(root, "/work/repo", files);
    const result = await describeMissingGuide(root, "/work/repo", changed);
    assert.equal(result.stale, true);
    assert.match(result.message, /Review changed since its prompt was copied/);
  });
  it("scopes the record to the working directory and ignores corrupt pointers", async (t) => {
    const { root } = await cacheIn(t);
    await rememberReview(root, "/work/repo", files);
    assert.equal((await describeMissingGuide(root, "/work/other", changed)).stale, false);
    await rememberReview(root, "/work/repo", files);
    const pointer = await readdir(join(root, "last"));
    assert.equal(pointer.length, 1);
    await writeFile(join(root, "last", pointer[0]), "../../etc/passwd\n");
    assert.equal((await describeMissingGuide(root, "/work/repo", changed)).stale, false);
  });
  it("keeps separate roots independent", async (t) => {
    const first = await cacheIn(t); const second = await cacheIn(t);
    await rememberReview(first.root, "/work/repo", files);
    assert.equal((await describeMissingGuide(second.root, "/work/repo", changed)).stale, false);
    assert.equal(await exists(second.root), false, "Reading a cache must not create it");
  });
});

describe("pruneGuides", () => {
  it("removes guides past the age limit but keeps recent ones", async (t) => {
    const { root } = await cacheIn(t);
    const old = await writeKeyed(guideDirectory(root), `${key("a")}.json`, 31 * DAY);
    const recent = await writeKeyed(guideDirectory(root), `${key("b")}.json`, 29 * DAY);
    assert.equal(await pruneGuides(root), 1);
    assert.equal(await exists(old), false);
    assert.equal(await exists(recent), true);
  });
  it("keeps only the newest guides beyond the count limit", async (t) => {
    const { root } = await cacheIn(t);
    const paths: string[] = [];
    for (const [index, character] of ["1", "2", "3", "4"].entries()) paths.push(await writeKeyed(guideDirectory(root), `${key(character)}.json`, (4 - index) * 1000));
    assert.equal(await pruneGuides(root, { maxCount: 2 }), 2);
    assert.deepEqual(await Promise.all(paths.map(exists)), [false, false, true, true]);
  });
  it("never removes a protected key, even when expired or over the limit", async (t) => {
    const { root } = await cacheIn(t);
    const protectedGuide = await writeKeyed(guideDirectory(root), `${key("c")}.json`, 90 * DAY);
    await writeKeyed(guideDirectory(root), `${key("d")}.json`, 0);
    await pruneGuides(root, { maxCount: 1, keep: new Set([key("c")]) });
    assert.equal(await exists(protectedGuide), true);
  });
  it("removes old last-review pointers but not recent ones", async (t) => {
    const { root } = await cacheIn(t);
    const directory = join(root, "last");
    const old = await writeKeyed(directory, `${"e".repeat(24)}.txt`, 40 * DAY);
    const recent = await writeKeyed(directory, `${"f".repeat(24)}.txt`, DAY);
    await pruneGuides(root);
    assert.equal(await exists(old), false);
    assert.equal(await exists(recent), true);
  });
  it("only touches plugin-named regular files", async (t) => {
    const { parent, root } = await cacheIn(t);
    const guides = guideDirectory(root);
    const unrelated = ["notes.json", "ABC.json", `${key("a")}.json.bak`, `${key("a")}x.json`];
    const paths = await Promise.all(unrelated.map((name) => writeKeyed(guides, name, 90 * DAY)));
    await mkdir(join(guides, `${key("9")}.json`), { recursive: true });
    const target = join(parent, "outside.txt");
    await writeFile(target, "precious");
    await symlink(target, join(guides, `${key("8")}.json`));
    assert.equal(await pruneGuides(root), 0);
    assert.deepEqual(await Promise.all(paths.map(exists)), unrelated.map(() => true));
    assert.equal(await exists(join(guides, `${key("9")}.json`)), true);
    assert.equal(await exists(target), true);
  });
  it("succeeds when the cache does not exist, without creating it", async (t) => {
    const { root } = await cacheIn(t);
    assert.equal(await pruneGuides(root), 0);
    assert.equal(await exists(root), false);
  });
  it("only operates inside the given root", async (t) => {
    const first = await cacheIn(t); const second = await cacheIn(t);
    const other = await writeKeyed(guideDirectory(second.root), `${key("a")}.json`, 90 * DAY);
    await writeKeyed(guideDirectory(first.root), `${key("b")}.json`, 90 * DAY);
    assert.equal(await pruneGuides(first.root), 1);
    assert.equal(await exists(other), true);
  });
  it("touchGuide refreshes a guide's age so used guides survive pruning", async (t) => {
    const { root } = await cacheIn(t);
    const path = await writeKeyed(guideDirectory(root), `${key("a")}.json`, 60 * DAY);
    await touchGuide(path);
    assert.equal(await pruneGuides(root), 0);
    assert.equal(await exists(path), true);
  });
});
