import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import type { ExtensionDiffFile, ExtensionPaneProps, HunkExtensionAPI } from "hunkdiff/extension";
import guidedReview from "../../src/index.tsx";
import { reviewIdentities, sameContentIdentities } from "../../src/guide.ts";
import { reviewPaths } from "../../src/storage.ts";
import { liveSessionId } from "../../src/session.ts";

// Hunk supplies real command snapshots and mounts the registered React pane.
// Capture only text passed to the host clipboard action by that pane's effect.
export default function smoke(hunk: HunkExtensionAPI) {
  let original: ExtensionDiffFile[] = [];
  let copyCwd: string | null = null;
  const result: {
    sessionId?: string;
    identities?: ReturnType<typeof reviewIdentities>;
    copies: { text: string; success: boolean }[];
    commandCompleted: boolean;
    error?: string;
  } = { copies: [], commandCompleted: false };
  const recordCopy = () => {
    if (copyCwd) writeFileSync(join(copyCwd, "session-prompt.json"), JSON.stringify(result));
  };
  hunk.transformChangeset((changeset) => { original = [...changeset.files]; return changeset; });
  guidedReview({ ...hunk, registerPane(pane) {
    const Component = pane.component as ComponentType<ExtensionPaneProps>;
    hunk.registerPane({ ...pane, component: (props) => createElement(Component, {
      ...props,
      actions: { ...props.actions, copyText(text) {
        const success = props.actions.copyText(text);
        result.copies.push({ text, success });
        recordCopy();
        return success;
      } },
    }) });
  }, registerCommand(command, handler) {
    hunk.registerCommand(command, async (ctx) => {
      const snapshot = ctx.review.snapshot();
      if (!snapshot) throw new Error("No real command snapshot");
      if (command.id === "reload-guide") {
        const paths = reviewPaths(ctx.cwd);
        await mkdir(paths.directory, { recursive: true });
        await writeFile(paths.guide, JSON.stringify({
          schemaVersion: 2, reviewFiles: reviewIdentities(snapshot.files),
          summary: "Authorization workflow smoke test",
          sections: [
            { id: "regression-tests", title: "Regression coverage", summary: "Test section explanation", files: ["tests/api.test.ts"] },
            { id: "permission-rule", title: "Permission rule", summary: "Implementation section explanation", files: ["src/api.ts"] },
          ],
        }));
      }
      if (command.id !== "copy-prompt") { await handler(ctx); return; }
      copyCwd = ctx.cwd;
      try {
        const cached = JSON.parse(await readFile(reviewPaths(ctx.cwd).guide, "utf8"));
        if (!sameContentIdentities(cached.reviewFiles, snapshot.files)) throw new Error("Hunk identities changed after file reordering");
        result.identities = reviewIdentities(snapshot.files);
        result.sessionId = await liveSessionId(snapshot.files.map((file) => ({ id: file.runtimeId, path: file.path })));
        await handler(ctx);
        result.commandCompleted = true;
      } catch (error) {
        result.error = String(error);
      }
      recordCopy();
    });
  } });
  hunk.transformChangeset(async (changeset, ctx) => {
    await writeFile(join(ctx.cwd, "review-order.json"), JSON.stringify({
      files: changeset.files.map((file) => file.path),
      identitiesPreserved: changeset.files.every((file) => original.includes(file)),
    }));
    return changeset;
  });
}
