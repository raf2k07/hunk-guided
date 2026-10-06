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
   action. No second click is needed. The clipboard
   contains instructions, the session ID, inspection commands, guide output path,
   and each file's host-provided `fileKey`, `contentIdentity`, and path. It contains
   **no patches or runtime navigation IDs**, and creates no prompt file.
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
   the changeset and section summaries. It creates the output directory if needed
   and writes `guide.json` at the supplied `outputPath`.
5. Choose **Extensions → Reload review guide**. The command checks the guide's
   identities against a fresh Hunk snapshot before requesting a review reload.
   The transform then applies the validated order and the sidebar shows the guide.
   A cached guide is not applied automatically at startup; reload it once to
   validate it against the current authoritative snapshot.

Changeset access goes exclusively through Hunk's live-session API. There is no
full-diff export or offline prompt path. If clipboard copying is unavailable,
enable OSC 52 support in your terminal. If session access is unavailable, restore
it and copy a fresh prompt before continuing.

If an agent cannot write files, save its JSON-only response at `outputPath`.
You can also use **Load review guide from file** to choose a different guide.
That selection lasts for this extension instance; otherwise the default cache
location is used on each launch.

The guide path is shown in the sidebar. Its default location is
`~/.cache/hunk-review-plugin/<hash-of-review-cwd>/guide.json`, outside the reviewed
working tree. Each working directory has one current default guide, so regenerate
when changing reviews. The extension does not write prompt files.

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
  "schemaVersion": 2,
  "reviewFiles": [
    { "fileKey": "copy from context", "contentIdentity": "copy from context", "path": "src/permissions.ts" }
  ],
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

Copy the entire `reviewFiles` array from the copied prompt unchanged. The
example above abbreviates it; a real guide must include every reviewed file's
native identities. File paths must match the live session exactly, including
rename targets. Legacy schema-1/fingerprint guides are rejected: copy a new
prompt and regenerate them.
Every file should be assigned once. A mixed-purpose file goes in its primary
section. Section IDs must be unique kebab-case; `other-changes` is reserved.

Validation rejects unknown files, duplicate ownership/IDs, unsupported schemas,
control characters, malformed JSON, and guides larger than 1 MiB. Unassigned
files are kept at the end in **Other changes**, never hidden. Binary and
oversized files remain included. Summaries are limited to 4,000 characters,
titles to 160, and IDs to 100. Prompt size scales with the number of native file
identities, not with patch size.

Content validity uses Hunk's opaque `fileKey`/`contentIdentity` values, compared
as a set with paths. The extension does not hash patch text or build its own
content digest. File ordering, runtime navigation IDs, notes, and store revision
numbers do not participate in persistent content validation.

Transforms cannot access native snapshots. They only reuse a command-validated
ordering while its previously loaded source fields match the replacement load;
changed source clears the active guide rather than inventing new identities.
Reload the guide command to revalidate it through Hunk. Missing, invalid, or stale
guides cannot introduce a new file order. `--watch` watches the diff source, not
the guide JSON.

## Privacy and current scope

The extension never starts an agent, executes repository configuration, sends
source over the network, or writes reviewed code. Copying queries Hunk's own
session list using its trusted runtime executable; it copies no source content.
The agent retrieves source through the live-session CLI, so its own provider may
receive that source. The prompt treats session output and patch content as
untrusted data, but that is not a sandbox:
configure your agent read-only and review its output.
AI summaries are navigation aids, not proof of correctness.

This first version intentionally does not implement provider adapters, automatic
agent execution, review progress, hunk-level grouping, or a custom diff renderer.

## Sources

- [Hunk extension API](https://hunk.dev/docs/extend/extension-api/)
- Hunk's bundled `skills/hunk-extensions/SKILL.md`
- Exact contracts shipped in `hunkdiff/extension` at version 0.23.0
