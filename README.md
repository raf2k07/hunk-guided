# Hunk guided review


NOTE: This README is AI generated, I will come back to this later and write something that reads better. Leaving it in because there's some important documentation steps



A Hunk extension that groups **whole files** into semantic review sections.
An external coding agent produces a JSON guide; the extension uses the same
section/file order for the diff stream and a dedicated right-hand sidebar.
Hunks, file identities, renderer metadata, and review notes are not rewritten.

Built and tested against **Hunk 0.23.0**, the latest published release at the
start of implementation. Requires extension API **27** or later. Hunk's API is
experimental, so the development version is pinned.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:smoke
```

`test:smoke` is written in TypeScript and uses Linux's util-linux `script` and
`stty` utilities to create a real PTY, without Python or an extra npm dependency.
It starts Hunk in an isolated temporary home, checks sidebar rendering and file
ordering, and terminates it within a bounded timeout. Unit tests and typechecking
do not require those utilities.
OpenTUI and React are development/type dependencies only: Hunk provides the
runtime instances. There is no build step and no provider SDK.

To try the extension from this checkout:

```sh
pnpm exec hunk diff --extension .
```

To review another repository, run Hunk there and pass the **absolute path to
this checkout** as `--extension`. The extension does not replace Hunk's existing
file pane. On narrow terminals, Hunk may omit side panes; enlarge the terminal
or use the toggle command.

## Agent workflow

1. Open the diff you want to review with the extension enabled. Working-tree,
   staged, commit, and patch reviews all use their **loaded diff**, not a new
   `git diff` invocation.
2. Choose **Extensions → Copy review prompt** and paste it into your agent.
   This single command captures Hunk's authoritative `ctx.review.snapshot()`,
   opens the sidebar if needed, and copies automatically through its host clipboard
   action. No second click is needed. The clipboard contains instructions, the
   session ID, inspection commands, the guide output path, a **`reviewKey`**, and a
   `fileCount`. It contains **no file list, patches, or per-file identities**, so its
   size does not grow with the diff, and it creates no prompt file. The agent reads
   the file list from Hunk itself. Copying also creates the guides directory so the
   agent only has to write a file.
3. The agent reads Hunk's bundled `hunk-review` skill and inspects the target:

   ```sh
   hunk session review <session-id> --json
   hunk session review <session-id> --include-patch --json
   ```

   The agent needs local command access and Hunk on its PATH (or can invoke it
   through `pnpm exec hunk`). It must inspect this session rather than substituting
   a fresh `git diff`. Before writing the guide, it checks that the session's
   files and patches have not changed since analysis.
4. The agent first organizes files into ordered semantic sections, then writes
   the changeset and section summaries, then writes the guide JSON to exactly the
   supplied `outputPath`.
5. Choose **Extensions → Reload review guide**. The command checks the guide's
   `reviewKey` and file paths against a fresh Hunk snapshot before requesting a
   review reload.
   The transform then applies the validated order and the sidebar shows the guide.
   A cached guide is not applied automatically at startup; run **Reload review
   guide** once in each new session to validate it against the current
   authoritative snapshot. If the same review was guided before, the guide is
   found automatically: no prompt, agent, or path is needed.
   If no guide matches, the sidebar says why (see *Guide storage*).

Changeset access goes exclusively through Hunk's live-session API. There is no
full-diff export or offline prompt path. If clipboard copying is unavailable,
enable OSC 52 support in your terminal. If session access is unavailable, restore
it and copy a fresh prompt before continuing.

If an agent cannot write files, save its JSON-only response at `outputPath`.
Guides are found only by the review's native identities; the extension has no
command for loading an arbitrary file.

## Guide storage

Guides live outside the reviewed working tree, at
`~/.cache/hunk-review-plugin/guides/<key>.json`. `<key>` is the first 32 hex
characters of a SHA-256 over the sorted `(fileKey, contentIdentity, path)` values
Hunk reports for the review: the same value the prompt gives the agent as
`reviewKey`. It is built entirely from Hunk's native identities, never from patch
text. The guide must echo it, and the extension recomputes it from a fresh
snapshot, so a guide only applies to the review content it was written for, both
because of where it is stored and because of what it says.

- **Reuse across sessions:** the same diff produces the same key in any session,
  working directory, or checkout, so **Reload review guide** finds an existing
  guide with no stored path. Identities were identical across separate Hunk
  processes in the smoke test, for both `hunk patch <file>` and `hunk patch -`
  (stdin) reviews. Working-tree and commit reviews are not covered by that test.
- **Exact matches only:** changing any reviewed file changes the key. The guide
  for the old content remains, but is not applied.
- **Stale-guide messages:** the extension records the last review whose prompt
  was copied or whose guide was loaded for each working directory
  (`~/.cache/hunk-review-plugin/last/`). When no guide matches the current review,
  the sidebar distinguishes *"Guide is out of date"* (a guide exists for that
  earlier review), *"Review changed since its prompt was copied"*, and a plain
  *"No guide for this review yet"*.
- **Pruning:** at startup and when copying a prompt, guides unused for 30 days are
  deleted, and only the newest 200 are kept. Loading a guide refreshes its age.
  Only regular files with the plugin's own names are removed; symlinks, directories,
  and other files are never touched, and the current review's guide is protected.
- **Hunk upgrades:** the identity algorithm isn't documented as stable. If it
  changes, old guides are simply not found and are pruned later.

The extension writes the guides directory, the last-review pointers, and updates
guide modification times; it never writes guide contents or prompt files.

## Reviews without local files (`gh pr diff | hunk patch -`)

The prompt works for these because the agent reads everything through
`hunk session review`, never through the working tree. Measured against Hunk 0.23.0
with a patch piped on stdin:

- **Sessions:** `hunk session list` and `hunk session review --json` work, with the
  same file list, paths, and hunk ranges as a file-backed review. They expose no
  `fileKey` or `contentIdentity`, which is why the prompt carries a `reviewKey`.
- **Keys:** identities and the `reviewKey` are stable across separate sessions, so a
  guide is reused for the same diff.
- **Pager chrome:** `hunk patch -` starts in pager-style chrome with no menu bar or
  side panes. The extension opens its pane on startup so the guide is visible;
  Hunk's own files pane stays under its usual `--sidebar` / toggle control.
- **No reload:** Hunk cannot rebuild a stdin review (`The current review cannot be
  reloaded from its original input`), so the guide **cannot reorder** the diff. The
  validated guide still groups the sidebar, and a note says the diff keeps its
  original order. Use a file-backed or git review to get the reordered stream.
- **No source reads:** `ctx.workspace.readDocument()` returned `null` for every file
  of a stdin review, even inside a checkout (and `sourceAttested` was unset), while
  working-tree and commit reviews returned `sourceAttested: true` with readable
  text. Any future feature that reads file contents must gate on
  `sourceAttested === true` per file and treat `null` as unavailable. It must not fall
  back to the working tree, which may not match the reviewed commit.
- **Last-review pointer:** it is per working directory, so two PRs reviewed from one
  directory share it. That can make the stale-guide message less specific; it never
  causes a guide to be applied to the wrong review.

Live-session instructions are in [`prompts/review-session.md`](prompts/review-session.md).
Agents without skill loading can follow the copied commands directly. No
agent-provider integration is required.

## Sidebar and commands

- **Copy review prompt** captures native content identities, resolves this
  process's exact live session, and copies using terminal clipboard integration
  (OSC 52) in one action. It refuses expired snapshot authority or changed content.
  If Hunk cannot mount the sidebar, it times out with instructions to enlarge the
  terminal and retry.
- Note-only state revisions do not invalidate content identities. Review reloads
  expire prompt authority, so copy a new prompt after a reload.
- Section titles jump to their first **visible** file.
- File rows jump to that file in the diff; selection follows normal navigation.
- The `+` / `−` control collapses or expands a section's explanation and files.
- Counts show visible/total files. Filtered files remain accounted for and cannot
  be clicked; section navigation skips entirely hidden sections.
- Next/previous section commands follow the guide order.

Commands are available in the **Extensions** menu. No default shortcuts are
claimed. Optional user configuration (for the checkout's default extension ID):

```toml
[keybindings]
"hunk-review-plugin.toggle-guide" = "ctrl+g"
"hunk-review-plugin.copy-prompt" = "alt+e"
"hunk-review-plugin.reload-guide" = "alt+r"
"hunk-review-plugin.next-section" = "alt+n"
"hunk-review-plugin.previous-section" = "alt+p"
```

Hunk identifies a single-entry folder extension by its folder name, so change
that prefix if you install or rename the folder differently. Existing shortcut
bindings may take precedence.

## Guide contract

```json
{
  "schemaVersion": 3,
  "reviewKey": "copy reviewKey from the prompt",
  "summary": "Introduce authorization checks for project updates.",
  "sections": [
    {
      "id": "permission-model",
      "title": "Define project permissions",
      "summary": "Introduce the permission model used by update endpoints.",
      "files": ["src/permissions.ts", "src/project.ts"]
    },
    {
      "id": "endpoint-enforcement",
      "title": "Enforce permissions",
      "summary": "Apply checks at the API boundary and verify denied updates.",
      "files": ["src/api/update-project.ts", "tests/update-project.test.ts"]
    }
  ]
}
```

Copy `reviewKey` from the prompt unchanged. File paths must match the live
session's `hunk session review --json` output exactly, including rename targets.
Legacy schema 1 (fingerprint) and schema 2 (identity-array) guides are rejected:
copy a fresh prompt and regenerate them.
Every file should be assigned once. A mixed-purpose file goes in its primary
section. Section IDs must be unique kebab-case; `other-changes` is reserved.

Validation rejects unknown files, duplicate ownership/IDs, unsupported schemas,
control characters, malformed JSON, and guides larger than 1 MiB. Unassigned
files are kept at the end in **Other changes**, never hidden. Binary and
oversized files remain included. Summaries are limited to 4,000 characters,
titles to 160, and IDs to 100. The prompt's size is constant: it does not depend
on the number of files or the size of the patch.

## Privacy and current scope

The extension never starts an agent, executes repository configuration, sends
source over the network, or writes reviewed code. Copying queries Hunk's own
session list using its trusted runtime executable; it copies no source content.
The agent retrieves source through the live-session CLI, so its own provider may
receive that source. The prompt treats session output and patch content as
untrusted data, but that is not a sandbox:
configure your agent read-only and review its output.
AI summaries are navigation aids, not proof of correctness.

## Sources

- [Hunk extension API](https://hunk.dev/docs/extend/extension-api/)
- Hunk's bundled `skills/hunk-extensions/SKILL.md`
- Exact contracts shipped in `hunkdiff/extension` at version 0.23.0
