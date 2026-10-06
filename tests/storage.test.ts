import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { reviewIdentities, StaleGuideError, type ReviewContentFile, type ReviewGuide } from "../src/guide.ts";
import { MAX_GUIDE_BYTES, readGuide, reviewPaths } from "../src/storage.ts";

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
    schemaVersion: 2,
    reviewFiles: reviewIdentities(files),
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
        assert.deepEqual(await readGuide(path, reordered), { ...guide, reviewFiles: reviewIdentities(reordered) });
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
    for (const schemaVersion of [1, 3]) {
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

describe("reviewPaths", () => {
  it("is deterministic for a cwd and equivalent resolved paths", async (t) => {
    const directory = await temporaryDirectory(t);
    const checkout = join(directory, "checkout");
    const paths = reviewPaths(checkout);
    assert.deepEqual(reviewPaths(checkout), paths);
    assert.deepEqual(reviewPaths(join(checkout, "nested", "..")), paths);
    assert.deepEqual(reviewPaths(relative(process.cwd(), checkout)), paths);
    assert.equal(paths.guide, join(paths.directory, "guide.json"));
    assert.deepEqual(Object.keys(paths).sort(), ["directory", "guide"]);
    assert.equal(relative(join(homedir(), ".cache", "hunk-review-plugin"), paths.directory).length, 24);
    assert.match(relative(join(homedir(), ".cache", "hunk-review-plugin"), paths.directory), /^[a-f0-9]{24}$/);
  });

  it("uses distinct directories for different checkouts and stays outside each checkout", async (t) => {
    const directory = await temporaryDirectory(t);
    const checkouts = [join(directory, "first", "repo"), join(directory, "second", "repo")];
    await Promise.all(checkouts.map((checkout) => mkdir(checkout, { recursive: true })));
    const paths = checkouts.map(reviewPaths);
    assert.notEqual(paths[0].directory, paths[1].directory);
    assert.notEqual(paths[0].guide, paths[1].guide);
    for (const [index, checkout] of checkouts.entries()) {
      assert.equal(resolve(checkout), checkout);
      for (const path of Object.values(paths[index])) {
        assert.ok(isAbsolute(path));
        assertOutside(checkout, path);
      }
      assert.deepEqual(await readdir(checkout), [], "Computing review paths must not write into the checkout");
    }
  });
});
