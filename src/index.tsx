
import type { ExtensionCommandContext, ExtensionDiffFile, HunkExtensionAPI } from "hunkdiff/extension";
import { orderFiles, sameContentIdentities, StaleGuideError, terminalText, type ReviewGuide } from "./guide.ts";
import { copyReviewPrompt } from "./prompt.ts";
import { sameLoadedSource } from "./review-source.ts";
import { createSidebar } from "./sidebar.tsx";
import { cacheRoot, describeMissingGuide, guidePath, pruneGuides, readGuide, rememberReview, touchGuide } from "./storage.ts";
import { createGuideStore } from "./store.ts";

const RELOAD_EVENT = "hunk-review-plugin:reload-guide";


export default function guidedReview(hunk: HunkExtensionAPI) {
  const store = createGuideStore();
  const root = cacheRoot();

  let validated: { guide: ReviewGuide; source: readonly ExtensionDiffFile[] } | null = null;
  let stale = false;

  hunk.registerPane({
    id: "guide", title: "Guided review", placement: "right", defaultOpen: true,
    width: { preferred: 42, min: 26, max: 60, fraction: 0.28 }, component: createSidebar(store),
  });

  hunk.transformChangeset((changeset) => {
    if (!validated) return changeset;
    if (!sameLoadedSource(validated.source, changeset.files)) {
      validated = null; stale = true;
      return changeset;
    }
    return { ...changeset, files: orderFiles(changeset.files, validated.guide) };
  });

  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    const guide = validated?.guide ?? null;
    store.set({
      status: guide ? "ready" : stale ? "stale" : "missing",
      message: guide ? "" : stale ? "Review changed. Reload the guide against Hunk's current snapshot." : "No validated review guide yet.",
      guide, changeset, guidePath: "", pendingCopy: null,
    });
  });

  // Bounded cache housekeeping; a failure here never affects the review.
  hunk.on("startup", async (_event, ctx) => {
    ctx.panes.open("guide");
    try { await pruneGuides(root); } catch { /* cache is optional */ }
  });

  hunk.events.on(RELOAD_EVENT, async (_payload, ctx) => {
    const result = await ctx.review.requestReload();
    if (!result.ok && result.reason === "unavailable" && validated) {
      // Hunk cannot rebuild some reviews (a patch read from stdin, for example), so
      // the file order cannot be applied. The guide was already validated against a
      // fresh snapshot, so group the sidebar by it and leave the diff order alone.
      store.set({ ...store.getSnapshot(), guide: validated.guide, status: "ready",
        message: `Shown in the sidebar only; the diff keeps its original order. ${result.detail}` });
      ctx.notify("Guide loaded. This review cannot be reordered, so it only groups the sidebar.");
      return;
    }
    if (!result.ok) {
      validated = null;
      store.set({ ...store.getSnapshot(), guide: null, status: "invalid", message: result.detail });
      ctx.notify(`Could not reload guide: ${result.detail}`, "warning");
    }
  });

  // The guide is found only by the current review's native identities, so any
  // session can reuse it; there is no user-supplied path.
  const loadGuide = async (ctx: ExtensionCommandContext) => {
    const captured = store.getSnapshot();
    const snapshot = ctx.review.snapshot();
    if (!captured.changeset || !snapshot) { ctx.notify("No review snapshot available", "warning"); return; }
    const path = guidePath(root, snapshot.files);
    try {
      const guide = await readGuide(path, snapshot.files);
      if (!guide) {

        const missing = await describeMissingGuide(root, ctx.cwd, snapshot.files);
        ctx.notify(missing.message, "warning");
        if (!validated && store.getSnapshot() === captured) {
          store.set({ ...captured, guidePath: path, status: missing.stale ? "stale" : "missing", message: missing.message });
        }
        return;
      }
      const current = ctx.review.snapshot();
      if (!current || current.generation !== snapshot.generation || !sameContentIdentities(snapshot.files, current.files) || store.getSnapshot() !== captured) {
        ctx.notify("Review changed; reload the guide again", "warning"); return;
      }

      validated = { guide, source: captured.changeset.files };
      stale = false;
      void Promise.allSettled([touchGuide(path), rememberReview(root, ctx.cwd, snapshot.files)]);
      hunk.events.emit(RELOAD_EVENT, null);
    } catch (error) {
      const message = terminalText(error instanceof Error ? error.message : String(error));
      ctx.notify(message, "warning");
      if (!validated && store.getSnapshot() === captured) store.set({ ...captured, status: error instanceof StaleGuideError ? "stale" : "invalid", message });
    }
  };

  hunk.registerCommand({ id: "copy-prompt", title: "Copy review prompt" }, (ctx) => copyReviewPrompt(store, ctx, { root }));
  hunk.registerCommand({ id: "toggle-guide", title: "Toggle guided review sidebar" }, (ctx) => ctx.panes.toggle("guide"));
  hunk.registerCommand({ id: "reload-guide", title: "Reload review guide" }, loadGuide);

  const stepSection = (ctx: ExtensionCommandContext, direction: 1 | -1) => {
    const guide = store.getSnapshot().guide;
    if (!guide) { ctx.notify("Load a review guide first", "warning"); return; }
    const visible = new Map(ctx.selection.files.map((file) => [file.path, file]));
    const current = guide.sections.findIndex((section) => section.files.includes(ctx.selection.file?.path ?? ""));
    let index = current < 0 ? (direction === 1 ? 0 : guide.sections.length - 1) : current + direction;
    while (index >= 0 && index < guide.sections.length) {
      const first = guide.sections[index].files.map((path) => visible.get(path)).find(Boolean);
      if (first) { ctx.navigation.selectFile(first.id); return; }
      index += direction;
    }
    ctx.notify(direction === 1 ? "No next visible section" : "No previous visible section");
  };
  hunk.registerCommand({ id: "next-section", title: "Next review section" }, (ctx) => stepSection(ctx, 1));
  hunk.registerCommand({ id: "previous-section", title: "Previous review section" }, (ctx) => stepSection(ctx, -1));
}
