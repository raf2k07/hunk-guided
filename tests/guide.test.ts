import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reviewIdentities,
  sameContentIdentities,
  orderFiles,
  parseGuide,
  StaleGuideError,
  terminalText,
  type ReviewContentFile,
  type ReviewGuide,
  type ReviewSection,
} from "../src/guide.ts";

function makeFile(path: string, overrides: Partial<ReviewContentFile> = {}): ReviewContentFile {
  return {
    fileKey: `host-file:${path}`,
    contentIdentity: `host-content:${path}:captured`,
    path,
    ...overrides,
  };
}

function makeSection(files: string[], overrides: Partial<ReviewSection> = {}): ReviewSection {
  return { id: "core-changes", title: "Core changes", summary: "Review the core changes.", files, ...overrides };
}

function makeGuide(files: readonly ReviewContentFile[], overrides: Partial<ReviewGuide> = {}): ReviewGuide {
  return {
    schemaVersion: 2,
    reviewFiles: reviewIdentities(files),
    summary: "Review these changes.",
    sections: [makeSection(files.map((file) => file.path))],
    ...overrides,
  };
}

const files = [makeFile("src/core.ts"), makeFile("src/ui.ts"), makeFile("README.md")];

function assertRejected(value: unknown, message: RegExp, reviewFiles: readonly ReviewContentFile[] = files): void {
  assert.throws(() => parseGuide(value, reviewFiles), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof StaleGuideError), "Schema errors must not be reported as stale guides");
    assert.match(error.message, message);
    return true;
  });
}

describe("native review identities", () => {
  it("projects only captured native identities without recomputing them or mutating input", () => {
    const input = Object.freeze(files.map((file, index) => Object.freeze({
      ...file,
      id: `runtime-${index}`,
      patch: "+content not used to recompute the host identity",
      stats: { additions: 10, deletions: 2 },
      isBinary: true,
      metadata: { selected: true },
    })));
    const projected = reviewIdentities(input);
    assert.deepEqual(projected, files);
    projected.forEach((file, index) => {
      assert.notStrictEqual(file, input[index]);
      assert.deepEqual(Object.keys(file).sort(), ["contentIdentity", "fileKey", "path"]);
    });
    assert.deepEqual(parseGuide(makeGuide(input), input).reviewFiles, files);
    assert.deepEqual(reviewIdentities([]), []);
  });

  it("compares identities independently of file order without mutating input", () => {
    const input = Object.freeze([...files]);
    for (const permutation of [
      [files[0], files[2], files[1]],
      [files[1], files[0], files[2]],
      [files[1], files[2], files[0]],
      [files[2], files[0], files[1]],
      [files[2], files[1], files[0]],
    ]) {
      assert.equal(sameContentIdentities(input, permutation), true);
      assert.equal(sameContentIdentities(permutation, input), true);
    }
    assert.deepEqual(input, files);
    assert.equal(sameContentIdentities([], []), true);
  });

  const changes: [string, Partial<ReviewContentFile>][] = [
    ["contentIdentity", { contentIdentity: "host-content:changed" }],
    ["fileKey", { fileKey: "host-file:replacement" }],
    ["path", { path: "src/renamed.ts" }],
  ];
  for (const [label, change] of changes) {
    it(`rejects a changed ${label}`, () => {
      const changed = [{ ...files[0], ...change }, ...files.slice(1)];
      assert.equal(sameContentIdentities(files, changed), false);
      assert.equal(sameContentIdentities(changed, files), false);
      assert.throws(() => parseGuide(makeGuide(files), changed), StaleGuideError);
      assert.throws(() => parseGuide(makeGuide(changed), files), StaleGuideError);
    });
  }

  it("rejects changes in file membership", () => {
    for (const changed of [files.slice(1), [...files, makeFile("extra.ts")]]) {
      assert.equal(sameContentIdentities(files, changed), false);
      assert.equal(sameContentIdentities(changed, files), false);
      assert.throws(() => parseGuide(makeGuide(files), changed), StaleGuideError);
    }
  });

  it("rejects duplicate keys on either side even when lengths match", () => {
    const duplicates = [files[0], files[0], files[2]];
    assert.equal(sameContentIdentities(duplicates, files), false);
    assert.equal(sameContentIdentities(files, duplicates), false);
    assert.equal(sameContentIdentities(duplicates, duplicates), false);
    assertRejected(makeGuide(duplicates), /Duplicate review fileKey/);
    assert.throws(() => parseGuide(makeGuide(files), duplicates), StaleGuideError);
  });

  it("ignores runtime IDs, patches, stats, flags, and metadata when host contentIdentity is unchanged", () => {
    const first = files.map((file, index) => ({
      ...file, id: `first-${index}`, patch: "old patch", previousPath: "old.ts",
      stats: { additions: 1, deletions: 1 }, isBinary: false, isTooLarge: false,
      isUntracked: false, metadata: { selected: false },
    }));
    const second = files.map((file, index) => ({
      ...file, id: `second-${index}`, patch: "changed patch", previousPath: "different.ts",
      stats: { additions: 100, deletions: 50 }, isBinary: true, isTooLarge: true,
      isUntracked: true, metadata: { selected: true },
    }));
    assert.deepEqual(reviewIdentities(first), reviewIdentities(second));
    assert.equal(sameContentIdentities(first, second), true);
    assert.deepEqual(parseGuide(makeGuide(first), second), makeGuide(files));
  });
});

describe("parseGuide schema validation", () => {
  it("accepts a valid guide even when the review files have been reordered", () => {
    const guide = makeGuide(files);
    assert.deepEqual(parseGuide(guide, [...files].reverse()), {
          ...guide, reviewFiles: reviewIdentities([...files].reverse()),
        });
  });

  for (const value of [null, undefined, false, 1, "guide", []]) {
    it(`rejects a non-object root: ${JSON.stringify(value)}`, () => {
      assertRejected(value, /Guide must be an object/);
    });
  }

  for (const schemaVersion of [undefined, null, "2", 0, 1, 3]) {
    it(`rejects schemaVersion ${JSON.stringify(schemaVersion)}`, () => {
      assertRejected({ ...makeGuide(files), schemaVersion }, /Unsupported guide schemaVersion/);
    });
  }

  for (const sections of [undefined, null, {}, "sections", [], Array.from({ length: 1001 }, () => makeSection([files[0].path]))]) {
    it(`rejects an invalid sections collection (${Array.isArray(sections) ? sections.length : typeof sections})`, () => {
      assertRejected({ ...makeGuide(files), sections }, /between 1 and 1000 sections/);
    });
  }

  for (const section of [null, false, "section", []]) {
    it(`rejects a non-object section: ${JSON.stringify(section)}`, () => {
      assertRejected({ ...makeGuide(files), sections: [section] }, /Section 1 must be an object/);
    });
  }

  const textFields = [
    { field: "summary", label: "Guide summary", max: 4000, root: true },
    { field: "id", label: "Section id", max: 100, root: false },
    { field: "title", label: "Section title", max: 160, root: false },
    { field: "summary", label: "Section summary", max: 4000, root: false },
  ] as const;
  for (const { field, label, max, root } of textFields) {
    for (const [kind, value] of [
      ["missing", undefined], ["null", null], ["non-string", 42],
      ["empty", ""], ["whitespace-only", " \t\n"], ["too long", "a".repeat(max + 1)],
    ] as const) {
      it(`rejects ${kind} ${label.toLowerCase()}`, () => {
        const guide = makeGuide(files);
        const invalid = root
          ? { ...guide, [field]: value }
          : { ...guide, sections: [{ ...guide.sections[0], [field]: value }] };
        assertRejected(invalid, new RegExp(`${label} must be nonempty text of at most ${max} characters`));
      });
    }
    it(`accepts ${label.toLowerCase()} at its length limit`, () => {
      const guide = makeGuide(files);
      const value = "a".repeat(max);
      const valid = root
        ? { ...guide, [field]: value }
        : { ...guide, sections: [{ ...guide.sections[0], [field]: value }] };
      assert.deepEqual(parseGuide(valid, files), valid);
    });
    for (const control of ["\u0000", "\u0008", "\u000b", "\r", "\u001b", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      it(`rejects terminal control U+${control.charCodeAt(0).toString(16)} in ${label.toLowerCase()}`, () => {
        const guide = makeGuide(files);
        const value = `before${control}after`;
        const invalid = root
          ? { ...guide, [field]: value }
          : { ...guide, sections: [{ ...guide.sections[0], [field]: value }] };
        assertRejected(invalid, new RegExp(`${label} contains terminal control characters`));
      });
    }
  }

  it("preserves allowed tabs, newlines, and Unicode in human-readable text", () => {
    const text = "Résumé\tレビュー\nSecond line 🚀";
    const guide = makeGuide(files, { summary: text, sections: [makeSection(files.map((file) => file.path), { title: text, summary: text })] });
    assert.deepEqual(parseGuide(guide, files), guide);
  });

  it("accepts the maximum of 1000 sections", () => {
    const manyFiles = Array.from({ length: 1000 }, (_, index) => makeFile(`file-${index}.ts`));
    const guide = makeGuide(manyFiles, {
      sections: manyFiles.map((file, index) => makeSection([file.path], { id: `section-${index}` })),
    });
    assert.deepEqual(parseGuide(guide, manyFiles), guide);
  });
});

describe("guide identity validation", () => {
  it("rejects a legacy schema 1 guide", () => {
    assertRejected({ schemaVersion: 1, diffFingerprint: "0".repeat(64), summary: "Legacy guide", sections: [makeSection(files.map((file) => file.path))] }, /Unsupported guide schemaVersion/);
  });

  for (const reviewFiles of [undefined, null, 42, "", {}]) {
    it(`rejects an invalid reviewFiles collection: ${JSON.stringify(reviewFiles)}`, () => {
      assertRejected({ ...makeGuide(files), reviewFiles }, /reviewFiles must contain Hunk's content identities/);
    });
  }

  for (const identity of [null, false, "identity", []]) {
    it(`rejects a non-object review identity: ${JSON.stringify(identity)}`, () => {
      assertRejected({ ...makeGuide(files), reviewFiles: [identity] }, /Review file 1 must be an object/);
    });
  }

  for (const field of ["fileKey", "contentIdentity", "path"] as const) {
    for (const value of [undefined, null, 42, ...(field === "path" ? [] : [""])]) {
      it(`rejects invalid identity ${field}: ${JSON.stringify(value)}`, () => {
        assertRejected({ ...makeGuide(files), reviewFiles: [{ ...files[0], [field]: value }, ...files.slice(1)] }, /must have fileKey, contentIdentity, and path strings/);
      });
    }
  }

  it("rejects an old guide after identity or membership changes, but accepts a regenerated guide", () => {
    const guide = makeGuide(files);
    for (const changed of [
      [{ ...files[0], contentIdentity: "host-content:changed" }, ...files.slice(1)],
      [{ ...files[0], fileKey: "host-file:changed" }, ...files.slice(1)],
      [{ ...files[0], path: "renamed.ts" }, ...files.slice(1)],
      files.slice(1),
      [...files, makeFile("new.ts")],
    ]) {
      assert.throws(() => parseGuide(guide, changed), {
        name: "Error",
        message: /different review content.*regenerate/,
      });
      assert.throws(() => parseGuide(guide, changed), StaleGuideError);
      assert.deepEqual(parseGuide(makeGuide(changed), changed), makeGuide(changed));
    }
  });
});

describe("guide file assignments and section IDs", () => {
  for (const id of ["other-changes", "Core", "has space", "has_underscore", "-leading", "trailing-", "two--hyphens", "a/b", "é"]) {
    it(`rejects invalid or reserved section ID ${JSON.stringify(id)}`, () => {
      assertRejected(makeGuide(files, { sections: [makeSection([files[0].path], { id })] }), /Invalid, reserved, or duplicate section id/);
    });
  }

  it("accepts lowercase alphanumeric section IDs with single hyphens", () => {
    const guide = makeGuide(files, { sections: [makeSection(files.map((file) => file.path), { id: "phase-2-api" })] });
    assert.deepEqual(parseGuide(guide, files), guide);
  });

  it("rejects duplicate section IDs even with disjoint files", () => {
    assertRejected(makeGuide(files, { sections: [makeSection([files[0].path]), makeSection([files[1].path])] }), /duplicate section id/);
  });

  for (const paths of [undefined, null, "src/core.ts", {}, [], files.map((file) => file.path).concat("extra.ts")]) {
    it(`rejects an invalid section file collection (${Array.isArray(paths) ? paths.length : typeof paths})`, () => {
      assertRejected({ ...makeGuide(files), sections: [{ ...makeSection([]), files: paths }] }, /must list at least one reviewed file/);
    });
  }

  for (const path of ["unknown.ts", "SRC/core.ts", "./src/core.ts", 42, null, {}]) {
    it(`rejects an unknown or non-string file: ${JSON.stringify(path)}`, () => {
      assertRejected({ ...makeGuide(files), sections: [{ ...makeSection([]), files: [path] }] }, /Unknown file in section/);
    });
  }

  it("rejects duplicate files within a section", () => {
    assertRejected(makeGuide(files, { sections: [makeSection([files[0].path, files[0].path])] }), /File assigned more than once/);
  });

  it("rejects duplicate files across sections", () => {
    assertRejected(makeGuide(files, { sections: [
      makeSection([files[0].path]),
      makeSection([files[0].path], { id: "ui-changes" }),
    ] }), /File assigned more than once/);
  });

  it("rejects ambiguous duplicate paths in the review input", () => {
    const duplicates = [files[0], { ...files[0], fileKey: "host-file:distinct", contentIdentity: "host-content:distinct" }];
    assertRejected(makeGuide(duplicates), /ambiguous duplicate file paths/, duplicates);
  });

  it("appends missing files under Other changes in original input order without mutating the guide", () => {
    const section = Object.freeze({ ...makeSection([files[1].path]), files: Object.freeze([files[1].path]) });
    const input = Object.freeze({ ...makeGuide(files), sections: Object.freeze([section]) });
    const parsed = parseGuide(input, Object.freeze([...files]));
    assert.equal(parsed.sections.length, 2);
    assert.deepEqual(parsed.sections[0], section);
    assert.deepEqual(parsed.sections[1], {
      id: "other-changes",
      title: "Other changes",
      summary: "These files were not assigned by the agent. Review them separately.",
      files: [files[0].path, files[2].path],
    });
    assert.equal(input.sections.length, 1);
  });

  it("does not append an empty Other changes section when all files are assigned", () => {
    const guide = makeGuide(files, { sections: [
      makeSection([files[2].path, files[0].path]),
      makeSection([files[1].path], { id: "ui-changes" }),
    ] });
    assert.deepEqual(parseGuide(guide, files), guide);
  });
});

describe("orderFiles", () => {
  it("requires only paths and preserves metadata references without native identity fields", () => {
    const originals = Object.freeze(files.map(({ path }, index) => Object.freeze({
      path, metadata: Object.freeze({ index }),
    })));
    const guide = makeGuide(files, { sections: [makeSection([files[2].path, files[0].path])] });
    const ordered = orderFiles(originals, guide);
    [originals[2], originals[0], originals[1]].forEach((original, index) => {
      assert.strictEqual(ordered[index], original);
      assert.strictEqual(ordered[index].metadata, original.metadata);
    });
  });
  it("follows section and file order, includes every file, and preserves exact objects and metadata", () => {
    const originals = Object.freeze(files.map((file, index) => Object.freeze({
      ...file,
      stats: Object.freeze({ additions: index + 1, deletions: index }),
      id: `navigation-${index}`,
      metadata: Object.freeze({ hunks: [{ id: index }], selected: index === 1 }),
    })));
    const guide = parseGuide(makeGuide(originals, { sections: [
      makeSection([originals[2].path]),
      makeSection([originals[0].path], { id: "core" }),
    ] }), originals);
    const before = JSON.stringify(guide);
    const ordered = orderFiles(originals, guide);
    assert.notStrictEqual(ordered, originals);
    assert.deepEqual(ordered.map((file) => file.path), [originals[2].path, originals[0].path, originals[1].path]);
    for (const [index, original] of [originals[2], originals[0], originals[1]].entries()) {
      assert.strictEqual(ordered[index], original);
      assert.strictEqual(ordered[index].stats, original.stats);
      assert.strictEqual(ordered[index].metadata, original.metadata);
      assert.strictEqual(ordered[index].metadata.hunks, original.metadata.hunks);
      assert.equal(ordered[index].id, original.id);
    }
    assert.equal(new Set(ordered).size, originals.length);
    assert.deepEqual(originals.map((file) => file.path), files.map((file) => file.path));
    assert.equal(JSON.stringify(guide), before);
  });

  it("preserves within-section ordering and appends files added after guide validation", () => {
    const guide = parseGuide(makeGuide(files, { sections: [makeSection([files[2].path, files[0].path, files[1].path])] }), files);
    const firstAdded = makeFile("new-a.ts");
    const secondAdded = makeFile("new-b.ts");
    const ordered = orderFiles([firstAdded, ...files, secondAdded], guide);
    const expected = [files[2], files[0], files[1], firstAdded, secondAdded];
    assert.equal(ordered.length, expected.length);
    expected.forEach((file, index) => assert.strictEqual(ordered[index], file));
  });

  it("ignores absent paths and repeated assignments without dropping unlisted files", () => {
    const guide = makeGuide(files, { sections: [
      makeSection(["removed.ts", files[1].path, files[1].path]),
      makeSection([files[1].path, files[2].path], { id: "second" }),
    ] });
    const ordered = orderFiles(files, guide);
    [files[1], files[2], files[0]].forEach((file, index) => assert.strictEqual(ordered[index], file));
    assert.equal(ordered.length, files.length);
    assert.deepEqual(orderFiles([], guide), []);
  });
});

describe("terminalText", () => {
  it("preserves ordinary Unicode text and empty strings", () => {
    for (const text of ["", "src/a.ts: +10 -2", "Résumé — レビュー 🚀", " a  b "]) {
      assert.equal(terminalText(text), text);
    }
  });

  it("replaces every C0, DEL, C1, and bidi embedding/isolate control with a space", () => {
    const ranges = [[0x00, 0x1f], [0x7f, 0x9f], [0x202a, 0x202e], [0x2066, 0x2069]];
    for (const [start, end] of ranges) {
      for (let code = start; code <= end; code++) {
        assert.equal(terminalText(`left${String.fromCodePoint(code)}right`), "left right", `U+${code.toString(16)}`);
      }
    }
  });

  it("neutralizes ANSI/OSC sequences and multiline text without interpreting them", () => {
    assert.equal(terminalText("\u001b[31mred\u001b[0m"), " [31mred [0m");
    assert.equal(terminalText("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"), " ]8;;https://example.com link ]8;; ");
    assert.equal(terminalText("line\nnext\r\tcolumn\b!"), "line next  column !");
    assert.equal(terminalText("safe\u202eevil\u202c\u2066isolated\u2069"), "safe evil  isolated ");
  });

  it("is idempotent", () => {
    const sanitized = terminalText("\u001b[2J\u009b31m\n\u202eRésumé 🚀\u2069");
    assert.equal(terminalText(sanitized), sanitized);
  });
});
