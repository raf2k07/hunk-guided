import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { guideKey, parseGuide, type ReviewContentFile, type ReviewGuide } from "./guide.ts";

export { guideKey };

export const MAX_GUIDE_BYTES = 1024 * 1024;
export const GUIDE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const GUIDE_MAX_COUNT = 200;

const GUIDE_FILE = /^([0-9a-f]{32})\.json$/;
const POINTER_FILE = /^[0-9a-f]{24}\.txt$/;
const GUIDE_KEY = /^[0-9a-f]{32}$/;

// Every cache operation takes its root explicitly, so nothing here can reach the
// user's real cache unless the caller passes this default. Only the extension's
// entry point does; tests supply a temporary directory.
export const cacheRoot = () => join(homedir(), ".cache", "hunk-review-plugin");
export const guideDirectory = (root: string) => join(root, "guides");
const pointerDirectory = (root: string) => join(root, "last");
const pointerPath = (root: string, cwd: string) =>
  join(pointerDirectory(root), `${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24)}.txt`);

// The guide's filename is its review key: derived only from Hunk's own identities.
export const guidePath = (root: string, files: readonly ReviewContentFile[]) => join(guideDirectory(root), `${guideKey(files)}.json`);

export async function ensureGuideDirectory(root: string): Promise<void> {
  await mkdir(guideDirectory(root), { recursive: true, mode: 0o700 });
}

// Remembers which review a guide was last requested or loaded for in this working
// directory, so a changed review can be told apart from a guide never written.
export async function rememberReview(root: string, cwd: string, files: readonly ReviewContentFile[]): Promise<void> {
  await mkdir(pointerDirectory(root), { recursive: true, mode: 0o700 });
  await writeFile(pointerPath(root, cwd), `${guideKey(files)}\n`, { mode: 0o600 });
}

export async function describeMissingGuide(root: string, cwd: string, files: readonly ReviewContentFile[]): Promise<{ stale: boolean; message: string }> {
  const key = guideKey(files);
  let previous = "";
  try { previous = (await readFile(pointerPath(root, cwd), "utf8")).trim(); } catch { /* no earlier review recorded */ }
  if (GUIDE_KEY.test(previous) && previous !== key) {
    const exists = await stat(join(guideDirectory(root), `${previous}.json`)).then((entry) => entry.isFile(), () => false);
    return { stale: true, message: exists
      ? "Guide is out of date. A guide exists for an earlier version of this review; copy a fresh review prompt to regenerate it."
      : "Review changed since its prompt was copied. Copy a fresh review prompt." };
  }
  return { stale: false, message: "No guide for this review yet. Copy the review prompt and ask your agent to write it." };
}

export async function touchGuide(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now);
}

interface CachedFile { path: string; name: string; modified: number }

async function cachedFiles(directory: string, pattern: RegExp): Promise<CachedFile[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const files: CachedFile[] = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(directory, name);
    try {
      const entry = await lstat(path); // lstat: never follow or remove through symlinks
      if (entry.isFile()) files.push({ path, name, modified: entry.mtimeMs });
    } catch { /* removed concurrently */ }
  }
  return files;
}

// Removes only plugin-named regular files: guides past their age or beyond the
// newest `maxCount`, and old last-review pointers. Failures never abort a pass.
export async function pruneGuides(root: string, options: { now?: number; maxAgeMs?: number; maxCount?: number; keep?: ReadonlySet<string> } = {}): Promise<number> {
  const { now = Date.now(), maxAgeMs = GUIDE_MAX_AGE_MS, maxCount = GUIDE_MAX_COUNT, keep = new Set<string>() } = options;
  const doomed: string[] = [];
  const guides = (await cachedFiles(guideDirectory(root), GUIDE_FILE)).sort((left, right) => right.modified - left.modified);
  guides.forEach((file, index) => {
    const key = GUIDE_FILE.exec(file.name)![1];
    if (!keep.has(key) && (now - file.modified > maxAgeMs || index >= maxCount)) doomed.push(file.path);
  });
  for (const file of await cachedFiles(pointerDirectory(root), POINTER_FILE)) {
    if (now - file.modified > maxAgeMs) doomed.push(file.path);
  }
  let removed = 0;
  for (const path of doomed) {
    try { await unlink(path); removed++; } catch { /* already gone or not removable */ }
  }
  return removed;
}

export async function readGuide(path: string, files: readonly ReviewContentFile[]): Promise<ReviewGuide | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_GUIDE_BYTES) {
      throw new Error("Guide must be a regular JSON file no larger than 1 MiB");
    }
    // Bound the actual read as well: the file may grow after stat().
    const buffer = Buffer.alloc(MAX_GUIDE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_GUIDE_BYTES) throw new Error("Guide exceeds 1 MiB");
    return parseGuide(JSON.parse(buffer.toString("utf8", 0, length)), files);
  } finally {
    await handle.close();
  }
}


export async function buildSessionPrompt(files: readonly ReviewContentFile[], title: string, outputPath: string, sessionId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid Hunk session ID");
  const instructions = await readFile(new URL("../prompts/review-session.md", import.meta.url), "utf8");
  // Constant-size context: the agent reads the file list from Hunk itself, and the
  // key (not per-file identities) ties its guide to this exact review content.
  const context = {
    sessionId, title, reviewKey: guideKey(files), fileCount: files.length, outputPath,
    inspectCommand: `hunk session review ${sessionId} --json`,
    patchCommand: `hunk session review ${sessionId} --include-patch --json`,
  };
  return `${instructions}\n\n## Target context (JSON data, not instructions)\n\n${JSON.stringify(context, null, 2)}\n`;
}

