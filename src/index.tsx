import { isAbsolute, resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionDiffFile, HunkExtensionAPI } from "hunkdiff/extension";
import { orderFiles, sameContentIdentities, StaleGuideError, terminalText, type ReviewGuide } from "./guide.ts";
import { copyReviewPrompt } from "./prompt.ts";
import { sameLoadedSource } from "./review-source.ts";
import { createSidebar } from "./sidebar.tsx";
import { readGuide, reviewPaths } from "./storage.ts";
import { createGuideStore } from "./store.ts";

const RELOAD_EVENT = "hunk-review-plugin:reload-guide";


export default function guidedReview(hunk: HunkExtensionAPI) {
  const store = createGuideStore();
  let selectedGuidePath: string | null = null;
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
      guide, changeset, guidePath: selectedGuidePath ?? reviewPaths(ctx.cwd).guide, pendingCopy: null,
    });
  });

  hunk.events.on(RELOAD_EVENT, async (_payload, ctx) => {
    const result = await ctx.review.requestReload();
    if (!result.ok) {
      validated = null;
      store.set({ ...store.getSnapshot(), guide: null, status: "invalid", message: result.detail });
      ctx.notify(`Could not reload guide: ${result.detail}`, "warning");
    }
  });

  const loadGuide = async (ctx: ExtensionCommandContext, path: string) => {
    const captured = store.getSnapshot();
    const snapshot = ctx.review.snapshot();
    if (!captured.changeset || !snapshot) { ctx.notify("No review snapshot available", "warning"); return; }
    try {
      const guide = await readGuide(path, snapshot.files);
      if (!guide) { ctx.notify("Guide file does not exist", "warning"); return; }
      const current = ctx.review.snapshot();
      if (!current || current.generation !== snapshot.generation || !sameContentIdentities(snapshot.files, current.files) || store.getSnapshot() !== captured) {
        ctx.notify("Review changed; reload the guide again", "warning"); return;
      }
      selectedGuidePath = path;
      validated = { guide, source: captured.changeset.files };
      stale = false;
      hunk.events.emit(RELOAD_EVENT, null);
    } catch (error) {
      const message = terminalText(error instanceof Error ? error.message : String(error));
      ctx.notify(message, "warning");
      if (!validated && store.getSnapshot() === captured) store.set({ ...captured, status: error instanceof StaleGuideError ? "stale" : "invalid", message });
    }
  };

  hunk.registerCommand({ id: "copy-prompt", title: "Copy review prompt" }, (ctx) => copyReviewPrompt(store, ctx));
  hunk.registerCommand({ id: "toggle-guide", title: "Toggle guided review sidebar" }, (ctx) => ctx.panes.toggle("guide"));
  hunk.registerCommand({ id: "reload-guide", title: "Reload review guide" }, (ctx) => loadGuide(ctx, selectedGuidePath ?? reviewPaths(ctx.cwd).guide));
  hunk.registerCommand({ id: "load-guide", title: "Load review guide from file" }, async (ctx) => {
    const captured = store.getSnapshot();
    if (!captured.changeset) return;
    const path = await ctx.dialogs.input({ title: "Review guide JSON path", initial: captured.guidePath });
    if (path === null) return;
    if (!path.trim() || /[\u0000-\u001f\u007f]/u.test(path)) { ctx.notify("Enter a valid file path", "warning"); return; }
    if (store.getSnapshot() !== captured) { ctx.notify("Review changed; load the guide again", "warning"); return; }
    await loadGuide(ctx, isAbsolute(path) ? path : resolve(ctx.cwd, path));
  });

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
