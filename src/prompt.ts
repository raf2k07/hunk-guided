import type { ExtensionCommandContext, ExtensionPaneActions } from "hunkdiff/extension";
import { sameContentIdentities, terminalText } from "./guide.ts";
import { liveSessionId } from "./session.ts";
import { buildSessionPrompt, ensureGuideDirectory, guideKey, guidePath, pruneGuides, rememberReview } from "./storage.ts";
import type { GuideStore } from "./store.ts";

export interface CopyPromptOptions {
  /** Cache directory for guides and last-review pointers; always explicit. */
  root: string;
  lookupSession?: typeof liveSessionId;
  timeoutMs?: number;
}

export async function copyReviewPrompt(store: GuideStore, ctx: ExtensionCommandContext, { root, lookupSession = liveSessionId, timeoutMs = 5000 }: CopyPromptOptions): Promise<void> {
  const snapshot = ctx.review.snapshot();
  const state = store.getSnapshot();
  if (!snapshot?.files.length || !state.changeset) { ctx.notify("No review snapshot available", "warning"); return; }
  if (state.pendingCopy) { ctx.notify("A review prompt copy is already pending", "warning"); return; }
  try {
    const sessionId = await lookupSession(snapshot.files.map((file) => ({ id: file.runtimeId, path: file.path })));
    const outputPath = guidePath(root, snapshot.files);
    const text = await buildSessionPrompt(snapshot.files, state.changeset.title, outputPath, sessionId);
    // Cache housekeeping is best-effort. It runs before the freshness check below so
    // no await separates that check from posting the request.
    await Promise.allSettled([
      ensureGuideDirectory(root),
      rememberReview(root, ctx.cwd, snapshot.files),
      pruneGuides(root, { keep: new Set([guideKey(snapshot.files)]) }),
    ]);
    const current = ctx.review.snapshot();
    if (!current || current.generation !== snapshot.generation || !sameContentIdentities(snapshot.files, current.files) || store.getSnapshot() !== state) {
      ctx.notify("Review changed; copy a fresh prompt", "warning"); return;
    }
    await new Promise<void>((resolve) => {
      const request = { text, snapshot, readSnapshot: () => ctx.review.snapshot(), complete: () => { clearTimeout(timeout); resolve(); } };
      const timeout = setTimeout(() => {
        if (store.getSnapshot().pendingCopy === request) store.set({ ...store.getSnapshot(), pendingCopy: null });
        ctx.notify(ctx.review.snapshot()
          ? "Clipboard pane unavailable. Enlarge the terminal and run Copy review prompt again."
          : "Review changed; copy a fresh prompt", "warning");
        resolve();
      }, timeoutMs);
      try {
        store.set({ ...state, guidePath: outputPath, pendingCopy: request });
        ctx.panes.open("guide");
      } catch (error) {
        if (store.getSnapshot().pendingCopy === request) store.set({ ...store.getSnapshot(), pendingCopy: null });
        request.complete();
        ctx.notify(`Could not copy review prompt: ${terminalText(error instanceof Error ? error.message : String(error))}`, "warning");
      }
    });
  } catch (error) {
    ctx.notify(`Could not copy review prompt: ${terminalText(error instanceof Error ? error.message : String(error))}`, "warning");
  }
}

// The command owns snapshot access; a mounted pane supplies host clipboard actions.
// Consume before copying so effect reruns or pane remounts cannot repeat a request.
export function flushPromptCopy(store: GuideStore, actions: Pick<ExtensionPaneActions, "copyText" | "notify">): void {
  const state = store.getSnapshot();
  const request = state.pendingCopy;
  if (!request) return;
  store.set({ ...state, pendingCopy: null });
  try {
    const current = request.readSnapshot();
    if (!current || current.generation !== request.snapshot.generation || !sameContentIdentities(request.snapshot.files, current.files)) {
      actions.notify("Review changed; copy a fresh prompt", "warning"); return;
    }
    if (!actions.copyText(request.text)) {
      actions.notify("Clipboard unavailable. Enable terminal clipboard support (OSC 52), then run Copy review prompt again.", "warning"); return;
    }
    actions.notify("Review prompt copied. Paste it into your agent, then reload the guide.");
  } catch (error) {
    actions.notify(`Could not copy review prompt: ${terminalText(error instanceof Error ? error.message : String(error))}`, "warning");
  } finally { request.complete(); }
}
