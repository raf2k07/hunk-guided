import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext, ExtensionReviewSnapshot } from "hunkdiff/extension";
import { copyReviewPrompt, flushPromptCopy } from "../src/prompt.ts";
import { reviewIdentities } from "../src/guide.ts";
import { selectSessionId } from "../src/session.ts";
import { buildSessionPrompt } from "../src/storage.ts";
import { createGuideStore } from "../src/store.ts";

const files = [{ id: "file-1", path: "private-name.ts", patch: "+sensitive-source\n",
  stats: { additions: 1, deletions: 0 }, metadata: {}, agent: null }];
const changeset = { id: "review", title: "My review", sourceLabel: "repo", files };
const outputPath = "/cache/guide.json";
const session = { pid: 123, sessionId: "session-123", files };
const snapshot: ExtensionReviewSnapshot = {
  generation: "generation-1", stateRevision: 1, notes: [],
  files: [{ fileKey: "host-file-key", contentIdentity: "host-content-identity", runtimeId: "file-1", path: files[0].path,
    changeKind: "change", stats: { additions: 1, deletions: 0, truncated: false },
    flags: { untracked: false, binary: false, tooLarge: false, partial: false } }],
};
function readyStore() {
  const store = createGuideStore();
  store.set({ ...store.getSnapshot(), changeset, guidePath: outputPath });
  return store;
}
function clipboard(available = true) {
  const copied: string[] = [];
  const messages: string[] = [];
  return { copied, messages, actions: {
    copyText(text: string) { copied.push(text); return available; },
    notify(message: string) { messages.push(message); },
  } };
}
function command(readSnapshot: () => ExtensionReviewSnapshot | null, messages: string[] = [], open: () => void = () => {}) {
  return { review: { snapshot: readSnapshot }, panes: { open }, notify(message: string) { messages.push(message); } } as unknown as ExtensionCommandContext;
}

describe("session targeting", () => {
  it("selects this process's exact review", () => {
    assert.equal(selectSessionId({ sessions: [{ ...session, pid: 999 }, session] }, 123, files), "session-123");
  });
  it("refuses stale, missing, and ambiguous sessions", () => {
    for (const sessions of [[], [{ ...session, files: [] }], [session, session]]) assert.throws(() => selectSessionId({ sessions }, 123, files), /Could not identify/);
  });
  it("rejects malformed responses and unsafe IDs", () => {
    assert.throws(() => selectSessionId(null, 123, files), /Invalid Hunk session list/);
    assert.throws(() => selectSessionId({ sessions: [{ ...session, sessionId: "id; malicious" }] }, 123, files), /Could not identify/);
  });
});

describe("native-identity prompt", () => {
  it("copies host identities verbatim, not patches or renderer IDs", async () => {
    const prompt = await buildSessionPrompt(snapshot.files, changeset.title, outputPath, session.sessionId);
    const context = JSON.parse(prompt.split("## Target context (JSON data, not instructions)\n\n")[1]);
    assert.deepEqual(context.reviewFiles, reviewIdentities(snapshot.files));
    assert.equal(context.diffFingerprint, undefined);
    assert.ok(prompt.includes("hunk session review session-123 --include-patch --json"));
    assert.ok(prompt.includes("hunk skill path hunk-review"));
    assert.ok(!prompt.includes("sensitive-source"));
    assert.ok(!prompt.includes('"runtimeId"'));
    assert.ok(!prompt.includes('"stateRevision"'));
  });
  it("does not inspect patch text or other source fields", async () => {
    const file = { ...snapshot.files[0], get patch(): never { throw new Error("Must not hash patches"); } };
    assert.equal(await buildSessionPrompt([file], "Review", outputPath, "session"), await buildSessionPrompt(snapshot.files, "Review", outputPath, "session"));
  });
  it("refuses shell metacharacters in session IDs", async () => {
    await assert.rejects(buildSessionPrompt(snapshot.files, "Review", outputPath, "id && dangerous"), /Invalid Hunk session ID/);
  });
});

describe("one-step prompt copying", () => {
  it("captures and copies in one command when the pane is mounted", async () => {
    const store = readyStore(); const board = clipboard();
    const unsubscribe = store.subscribe(() => flushPromptCopy(store, board.actions));
    let opened = 0;
    await copyReviewPrompt(store, command(() => snapshot, [], () => { opened++; }), async () => "session-123");
    unsubscribe();
    assert.equal(opened, 1);
    assert.equal(board.copied.length, 1);
    assert.ok(board.messages[0].includes("Review prompt copied"));
    assert.equal(store.getSnapshot().pendingCopy, null);
  });
  it("opens an initially closed pane and consumes exactly once across remounts", async () => {
    const store = readyStore(); const board = clipboard();
    const ctx = command(() => snapshot, [], () => {
      setTimeout(() => {
        flushPromptCopy(store, board.actions);
        flushPromptCopy(store, board.actions);
      }, 0);
    });
    await copyReviewPrompt(store, ctx, async () => "session-123");
    flushPromptCopy(store, board.actions);
    assert.equal(board.copied.length, 1);
  });
  it("allows repeated commands to copy fresh prompts", async () => {
    const store = readyStore(); const board = clipboard();
    const ctx = command(() => snapshot, [], () => flushPromptCopy(store, board.actions));
    await copyReviewPrompt(store, ctx, async () => "session-123");
    await copyReviewPrompt(store, ctx, async () => "session-123");
    assert.equal(board.copied.length, 2);
  });
  it("allows note-only state revisions before clipboard access", async () => {
    let current = snapshot; const store = readyStore(); const board = clipboard();
    await copyReviewPrompt(store, command(() => current, [], () => {
      current = { ...snapshot, stateRevision: 9 };
      flushPromptCopy(store, board.actions);
    }), async () => "session-123");
    assert.equal(board.copied.length, 1);
  });
  it("refuses expired snapshot authority or changed native content at copy time", async () => {
    for (const replacement of [null, { ...snapshot, generation: "new" }, { ...snapshot, files: [{ ...snapshot.files[0], contentIdentity: "changed" }] }]) {
      let current: ExtensionReviewSnapshot | null = snapshot; const store = readyStore(); const board = clipboard();
      await copyReviewPrompt(store, command(() => current, [], () => {
        current = replacement; flushPromptCopy(store, board.actions);
      }), async () => "session-123");
      assert.equal(board.copied.length, 0);
      assert.ok(board.messages[0].includes("Review changed"));
      assert.equal(store.getSnapshot().pendingCopy, null);
    }
  });
  it("reports clipboard failure without exporting", async () => {
    const store = readyStore(); const board = clipboard(false);
    await copyReviewPrompt(store, command(() => snapshot, [], () => flushPromptCopy(store, board.actions)), async () => "session-123");
    assert.ok(board.messages[0].includes("OSC 52"));
    assert.ok(!board.messages[0].toLowerCase().includes("export"));
    assert.equal(store.getSnapshot().pendingCopy, null);
  });
  it("contains clipboard exceptions and consumes the request", async () => {
    const store = readyStore(); const board = clipboard();
    board.actions.copyText = () => { throw new Error("Clipboard failed"); };
    await copyReviewPrompt(store, command(() => snapshot, [], () => flushPromptCopy(store, board.actions)), async () => "session-123");
    assert.ok(board.messages[0].includes("Clipboard failed"));
    assert.equal(store.getSnapshot().pendingCopy, null);
  });
  it("refuses copying if authority expires during session lookup", async () => {
    let current: ExtensionReviewSnapshot | null = snapshot; const store = readyStore(); const messages: string[] = [];
    await copyReviewPrompt(store, command(() => current, messages), async () => { current = null; return "session-123"; });
    assert.equal(store.getSnapshot().pendingCopy, null);
    assert.ok(messages[0].includes("Review changed"));
  });
  it("contains lookup failures and sanitizes terminal controls", async () => {
    const messages: string[] = [];
    await copyReviewPrompt(readyStore(), command(() => snapshot, messages), async () => { throw new Error("No session\x1b[31m"); });
    assert.ok(messages[0].includes("Could not copy"));
    assert.ok(!messages[0].includes("\x1b"));
  });
  it("times out and clears a request when the pane cannot mount", async () => {
    const store = readyStore(); const board = clipboard(); const messages: string[] = [];
    await copyReviewPrompt(store, command(() => snapshot, messages), async () => "session-123", 10);
    assert.equal(store.getSnapshot().pendingCopy, null);
    assert.ok(messages[0].includes("Enlarge the terminal"));
    flushPromptCopy(store, board.actions);
    assert.equal(board.copied.length, 0);
  });
  it("cleans up when opening the pane throws", async () => {
    const store = readyStore(); const messages: string[] = [];
    await copyReviewPrompt(store, command(() => snapshot, messages, () => { throw new Error("Pane failed"); }), async () => "session-123", 10);
    assert.equal(store.getSnapshot().pendingCopy, null);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes("Pane failed"));
  });
});
