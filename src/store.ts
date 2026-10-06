import type { ExtensionChangeset, ExtensionReviewSnapshot } from "hunkdiff/extension";
import type { ReviewGuide } from "./guide.ts";

export interface GuideState {
  status: "empty" | "ready" | "missing" | "stale" | "invalid";
  message: string;
  guide: ReviewGuide | null;
  changeset: ExtensionChangeset | null;
  guidePath: string;
  pendingCopy: { text: string; snapshot: ExtensionReviewSnapshot; readSnapshot: () => ExtensionReviewSnapshot | null; complete: () => void } | null;
}

export function createGuideStore() {
  let state: GuideState = {
    status: "empty", message: "Waiting for the review…", guide: null,
    changeset: null, guidePath: "", pendingCopy: null,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next: GuideState) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

export type GuideStore = ReturnType<typeof createGuideStore>;
