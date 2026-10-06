import type { ExtensionReviewSnapshotFile } from "hunkdiff/extension";

export type ReviewContentFile = Pick<ExtensionReviewSnapshotFile, "fileKey" | "contentIdentity" | "path">;

export interface ReviewSection {
  id: string;
  title: string;
  summary: string;
  files: string[];
}

export interface ReviewGuide {
  schemaVersion: 2;
  reviewFiles: ReviewContentFile[];
  summary: string;
  sections: ReviewSection[];
}

export class StaleGuideError extends Error {}

export function reviewIdentities(files: readonly ReviewContentFile[]): ReviewContentFile[] {
  return files.map(({ fileKey, contentIdentity, path }) => ({ fileKey, contentIdentity, path }));
}

export function sameContentIdentities(left: readonly ReviewContentFile[], right: readonly ReviewContentFile[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(right.map((file) => [file.fileKey, file]));
  if (expected.size !== right.length) return false;
  const seen = new Set<string>();
  return left.every((file) => {
    if (seen.has(file.fileKey)) return false;
    seen.add(file.fileKey);
    const current = expected.get(file.fileKey);
    return current?.contentIdentity === file.contentIdentity && current.path === file.path;
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} must be nonempty text of at most ${max} characters`);
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} contains terminal control characters`);
  }
  return value;
}

export function parseGuide(value: unknown, files: readonly ReviewContentFile[]): ReviewGuide {
  const root = record(value, "Guide");
  if (root.schemaVersion !== 2) throw new Error("Unsupported guide schemaVersion; expected 2. Prepare a new review prompt.");
  if (!Array.isArray(root.reviewFiles)) throw new Error("Guide reviewFiles must contain Hunk's content identities");
  const identities = root.reviewFiles.map((value, index): ReviewContentFile => {
    const file = record(value, `Review file ${index + 1}`);
    if (typeof file.fileKey !== "string" || !file.fileKey || typeof file.contentIdentity !== "string" || !file.contentIdentity || typeof file.path !== "string") {
      throw new Error("Review files must have fileKey, contentIdentity, and path strings");
    }
    return { fileKey: file.fileKey, contentIdentity: file.contentIdentity, path: file.path };
  });
  if (new Set(identities.map((file) => file.fileKey)).size !== identities.length) throw new Error("Duplicate review fileKey");
  if (!sameContentIdentities(identities, files)) {
    throw new StaleGuideError("Guide belongs to different review content. Prepare a new prompt and regenerate it.");
  }
  const summary = text(root.summary, "Guide summary", 4000);
  if (!Array.isArray(root.sections) || root.sections.length === 0 || root.sections.length > 1000) {
    throw new Error("Guide sections must contain between 1 and 1000 sections");
  }
  const known = new Set(files.map((file) => file.path));
  if (known.size !== files.length) throw new Error("Review has ambiguous duplicate file paths");
  const assigned = new Set<string>();
  const ids = new Set<string>();
  const sections = root.sections.map((value, index): ReviewSection => {
    const section = record(value, `Section ${index + 1}`);
    const id = text(section.id, "Section id", 100);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id === "other-changes" || ids.has(id)) {
      throw new Error(`Invalid, reserved, or duplicate section id: ${id}`);
    }
    ids.add(id);
    if (!Array.isArray(section.files) || section.files.length === 0 || section.files.length > files.length) {
      throw new Error(`Section ${id} must list at least one reviewed file`);
    }
    const paths = section.files.map((path: unknown) => {
      if (typeof path !== "string" || !known.has(path)) throw new Error(`Unknown file in section ${id}: ${String(path)}`);
      if (assigned.has(path)) throw new Error(`File assigned more than once: ${path}`);
      assigned.add(path);
      return path;
    });
    return { id, title: text(section.title, "Section title", 160),
      summary: text(section.summary, "Section summary", 4000), files: paths };
  });
  const remaining = files.filter((file) => !assigned.has(file.path)).map((file) => file.path);
  if (remaining.length) {
    sections.push({ id: "other-changes", title: "Other changes",
      summary: "These files were not assigned by the agent. Review them separately.", files: remaining });
  }
  return { schemaVersion: 2, reviewFiles: reviewIdentities(files), summary, sections };
}

export function orderFiles<T extends { path: string }>(files: readonly T[], guide: ReviewGuide): T[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const ordered: T[] = [];
  for (const section of guide.sections) {
    for (const path of section.files) {
      const file = byPath.get(path);
      if (file) { ordered.push(file); byPath.delete(path); }
    }
  }
  // Preserve anything added after validation rather than silently dropping it.
  ordered.push(...byPath.values());
  return ordered;
}

export function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
}
