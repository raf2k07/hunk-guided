import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";


const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// OpenTUI sends incremental cell updates, not complete frames. Interpret cursor
// movement so assertions see the screen, rather than concatenated paint fragments.
function screenText(output: string): string {
  const screen = Array.from({ length: 40 }, () => Array<string>(180).fill(" "));
  let row = 0, column = 0;
  const tokens = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b\[([0-?]*)([ -/]*)([@-~])|\u001b[()][A-Z0-9]|[\s\S]/gu;
  for (const token of output.matchAll(tokens)) {
    if (token[3]) {
      const values = token[1].split(";").map((value) => Number(value) || 0);
      const count = values[0] || 1;
      switch (token[3]) {
        case "H": case "f": row = Math.min(39, Math.max(0, (values[0] || 1) - 1)); column = Math.min(179, Math.max(0, (values[1] || 1) - 1)); break;
        case "A": row = Math.max(0, row - count); break;
        case "B": row = Math.min(39, row + count); break;
        case "C": column = Math.min(179, column + count); break;
        case "D": column = Math.max(0, column - count); break;
        case "G": column = Math.min(179, count - 1); break;
        case "d": row = Math.min(39, count - 1); break;
        case "J":
          if (values[0] === 2 || values[0] === 3) screen.forEach((line) => line.fill(" "));
          else { screen[row].fill(" ", column); for (let next = row + 1; next < 40; next++) screen[next].fill(" "); }
          break;
        case "K": screen[row].fill(" ", values[0] === 1 || values[0] === 2 ? 0 : column, values[0] === 1 ? column + 1 : 180); break;
      }
    } else if (token[0].startsWith("\x1b")) continue;
    else if (token[0] === "\r") column = 0;
    else if (token[0] === "\n") row = Math.min(39, row + 1);
    else if (token[0].codePointAt(0)! >= 32) { screen[row][column] = token[0]; column = Math.min(179, column + 1); }
  }
  return screen.map((line) => line.join("")).join("\n");
}

// The emulated screen without blank rows, for readable failure messages.
function visibleScreen(output: string): string {
  return screenText(output).split("\n").map((line) => line.trimEnd()).filter(Boolean).join("\n");
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const terminate = setTimeout(() => signalGroup(child, "SIGKILL"), 3000);
    const deadline = setTimeout(() => {
      cleanup(); reject(new Error("Smoke-test process did not terminate within 6 seconds"));
    }, 6000);
    const cleanup = () => {
      clearTimeout(terminate); clearTimeout(deadline);
      child.off("exit", onExit);
    };
    const onExit = () => { cleanup(); resolve(); };
    child.once("exit", onExit);
    signalGroup(child, "SIGINT");
  });
}

interface SmokeOptions {
  extension: string;
  required: string[];
  /** Load the instrumented fixture and send Ctrl-G to reload the guide. Defaults to `checkOrder`. */
  instrumented?: boolean;
  /** Verify the review was reordered by the guide. */
  checkOrder?: boolean;
  /** Also send Ctrl-E and verify the automatically copied prompt. */
  copyPrompt?: boolean;
  /** False simulates a later session that finds an already-written guide. */
  writeGuide?: boolean;
  /** Share HOME and cwd with other launches; the caller owns cleanup. */
  workspace?: string;
  patch?: string;
  /** Feed the patch on stdin (`hunk patch -`), like `gh pr diff | hunk patch -`. */
  stdin?: boolean;

  /** Expected review order, when `checkOrder` is set. */
  order?: string[];
}

async function smoke(options: SmokeOptions): Promise<void> {
  let extension = options.extension;
  const { required, checkOrder = false, copyPrompt = false, writeGuide = true } = options;
  const instrumented = options.instrumented ?? checkOrder;
  const owned = !options.workspace;
  const temporary = options.workspace ?? await mkdtemp(join(tmpdir(), "hunk-review-smoke-"));
  let child: ChildProcess | undefined;
  try {
    if (instrumented) {
      // Hunk serves its React instance only beneath the extension loader root.
      const extensionRoot = join(temporary, "extension");
      await cp(join(root, "src"), join(extensionRoot, "src"), { recursive: true });
      await cp(join(root, "prompts"), join(extensionRoot, "prompts"), { recursive: true });
      const wrapper = (await readFile(extension, "utf8")).replaceAll('"../../src/', '"./src/');
      extension = join(extensionRoot, "smoke.ts");
      await writeFile(extension, wrapper);
      await mkdir(join(temporary, "hunk"), { recursive: true });
      await writeFile(join(temporary, "hunk", "config.toml"), '[keybindings]\n"smoke.reload-guide" = "ctrl+g"\n"smoke.copy-prompt" = "ctrl+e"\n');
    }

    const args = [join(root, "node_modules/.bin/hunk"), "patch",
      options.stdin ? "-" : (options.patch ?? join(root, "tests/fixtures/review.patch")), "--extension", extension];
    // util-linux script supplies a real PTY; all dynamic arguments are quoted.
    const redirect = options.stdin ? ` < ${shellQuote(options.patch ?? join(root, "tests/fixtures/review.patch"))}` : "";
    const command = `stty rows 40 cols 180; exec ${args.map(shellQuote).join(" ")}${redirect}`;
    child = spawn("script", ["--quiet", "--return", "--command", command, "/dev/null"], {
      cwd: temporary, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor",
        HOME: temporary, XDG_CONFIG_HOME: temporary, XDG_CACHE_HOME: temporary,
        SMOKE_WRITE_GUIDE: writeGuide ? "1" : "0" },
    });
    const running = child;
    let output = "";
    let requestedGuide = false;
    const decoder = new StringDecoder("utf8");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(
        `Hunk sidebar smoke test timed out; missing: ${required.filter((message) => !screenText(output).includes(message)).join(", ")}\n${visibleScreen(output)}`,
      )), 8000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        running.stdout?.off("data", onData); running.stderr?.off("data", onData);
        running.off("error", onError); running.off("exit", onExit);
        if (error) reject(error); else resolve();
      };
      const onError = (error: Error) => finish(new Error(
        `Could not start PTY smoke test; install util-linux (script and stty). ${error.message}`,
      ));
      const onExit = (code: number | null) => finish(new Error(`Hunk exited early (${code})\n${visibleScreen(output)}`));
      const onData = (chunk: Buffer) => {
        output += decoder.write(chunk);
        if (chunk.includes(Buffer.from("\x1b[6n"))) running.stdin?.write("\x1b[1;1R");
        if (chunk.includes(Buffer.from("\x1b[c"))) running.stdin?.write("\x1b[?1;2c");
        if (instrumented && !requestedGuide && screenText(output).includes("No validated review guide yet")) {
          requestedGuide = true;
          running.stdin?.write("\x07");
        }
        if (required.every((message) => screenText(output).includes(message))) {
          if (copyPrompt) running.stdin?.write("\x05");
          finish();
        }
      };
      running.stdout?.on("data", onData); running.stderr?.on("data", onData);
      running.once("error", onError); running.once("exit", onExit);
    });
    if (checkOrder) {
      const result = JSON.parse(await readFile(join(temporary, "review-order.json"), "utf8"));
      assert.deepEqual(result.files, options.order ?? ["tests/api.test.ts", "src/api.ts"]);
      assert.equal(result.identitiesPreserved, true);
    }
    if (copyPrompt) {
      const result = JSON.parse(await readFile(join(temporary, "review-order.json"), "utf8"));
      let sessionPrompt: {
        sessionId?: string;
        reviewKey?: string;
        fileCount?: number;
        copies: { text: string; success: boolean }[];
        commandCompleted: boolean;
        error?: string;
      } | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          sessionPrompt = JSON.parse(await readFile(join(temporary, "session-prompt.json"), "utf8"));
          if (sessionPrompt?.commandCompleted || sessionPrompt?.error) break;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await delay(100);
      }
      assert.ok(sessionPrompt, "Automatic prompt copy did not finish");
      assert.equal(sessionPrompt.error, undefined);
      assert.equal(sessionPrompt.commandCompleted, true, "Copy command did not complete through the pane effect");
      // Allow follow-up React effects to settle, then check the complete call log.
      await delay(200);
      sessionPrompt = JSON.parse(await readFile(join(temporary, "session-prompt.json"), "utf8")) as typeof sessionPrompt;
      assert.equal(sessionPrompt.copies.length, 1, "One command must automatically copy exactly once, without a pane click");
      assert.equal(sessionPrompt.copies[0].success, true, "Host clipboard action rejected the prompt");
      assert.ok(sessionPrompt.sessionId);
      const prompt = sessionPrompt.copies[0].text;
      assert.ok(prompt.includes(`hunk session review ${sessionPrompt.sessionId} --include-patch --json`));
      assert.ok(!prompt.includes("export const authorized"));
      const context = JSON.parse(prompt.split("## Target context (JSON data, not instructions)\n\n")[1]);
      assert.equal(context.sessionId, sessionPrompt.sessionId);
      assert.equal(context.diffFingerprint, undefined);
      // The prompt is constant-size: one key and a count, with no per-file identities
      // or paths. The agent reads the file list from Hunk's session API.
      assert.equal(context.reviewFiles, undefined);
      assert.ok(!prompt.includes('"fileKey"') && !prompt.includes('"contentIdentity"'));
      for (const path of result.files) assert.ok(!prompt.includes(path), `Prompt must not embed ${path}`);
      assert.match(context.reviewKey, /^[0-9a-f]{32}$/);
      assert.equal(context.reviewKey, sessionPrompt.reviewKey, "Key must match the real reordered command snapshot");
      assert.equal(context.fileCount, sessionPrompt.fileCount);
      assert.equal(context.fileCount, result.files.length);

      // The agent is told to write to the content-keyed path under the cache, which
      // Hunk's extension created, and the guide the fixture wrote is found there.
      const guides = join(temporary, ".cache", "hunk-review-plugin", "guides");
      assert.equal(context.outputPath, join(guides, `${context.reviewKey}.json`));
      assert.ok(await exists(context.outputPath), "Guide should be stored under its content key");
      const pointers = join(temporary, ".cache", "hunk-review-plugin", "last");
      assert.deepEqual(await Promise.all((await readdir(pointers)).map((name) => readFile(join(pointers, name), "utf8"))),
        [`${context.reviewKey}\n`], "The last requested review should be recorded");
    }
  } finally {
    try { if (child) await stop(child); }
    finally { if (owned) await rm(temporary, { recursive: true, force: true }); }
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

await smoke({ extension: root, required: ["Guided review", "No validated review guide yet", "Copy review prompt"] });
console.log("Hunk 0.23.0 loaded the folder extension and rendered its empty sidebar.");

const fixture = join(root, "tests/fixtures/guide-smoke.ts");
const loaded = [
  "Guided review", "Authorization workflow smoke test", "Regression coverage",
  "Permission rule", "Test section explanation", "Implementation section explanation",
];
// Three launches share one HOME and working directory, like successive sessions.
const workspace = await mkdtemp(join(tmpdir(), "hunk-review-smoke-"));
try {
  const guides = join(workspace, ".cache", "hunk-review-plugin", "guides");
  await mkdir(guides, { recursive: true });
  const expired = join(guides, `${"a".repeat(32)}.json`);
  const fresh = join(guides, `${"b".repeat(32)}.json`);
  await writeFile(expired, "{}"); await writeFile(fresh, "{}");
  const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  await utimes(expired, longAgo, longAgo);

  await smoke({ extension: fixture, required: loaded, checkOrder: true, copyPrompt: true, workspace });
  assert.equal(await exists(expired), false, "Startup should prune guides past the age limit");
  assert.equal(await exists(fresh), true, "Startup must keep recent guides");
  console.log("Hunk validated and reordered a guide using real command snapshots and automatically copied its native content identities exactly once through the React pane.");
  console.log("Hunk stored the guide under its content key and pruned an expired guide at startup.");

  // A new Hunk process: the guide is found by native identities, not rewritten.
  const before = (await readdir(guides)).sort();
  await smoke({ extension: fixture, required: loaded, checkOrder: true, writeGuide: false, workspace });
  assert.deepEqual((await readdir(guides)).sort(), before, "Reusing a guide must not write another");
  console.log("A new Hunk session found and applied the cached guide without regenerating it.");

  // Same repository, changed diff: no guide exists for it, and an earlier one does.
  const changedPatch = join(workspace, "changed.patch");
  await writeFile(changedPatch, (await readFile(join(root, "tests/fixtures/review.patch"), "utf8")).replace("toBe(true)", "toBe(1)"));
  await smoke({ extension: fixture, required: ["Guided review", "Guide is out of date"], instrumented: true, writeGuide: false, workspace, patch: changedPatch });
  console.log("A changed review reported the earlier guide as out of date.");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

// A review with no local files behind it, like `gh pr diff | hunk patch -`. Hunk has
// no sources to read, so the prompt must work through the session API alone, and a
// later session must still find the guide by the review's native identities.
// Hunk cannot reload a stdin review, so the guide groups the sidebar only and the
// diff keeps its original order.
const stdinOrder = ["src/api.ts", "tests/api.test.ts"];
const pullRequest = await mkdtemp(join(tmpdir(), "hunk-review-smoke-"));
try {
  await smoke({ extension: fixture, required: loaded, checkOrder: true, copyPrompt: true, workspace: pullRequest, stdin: true, order: stdinOrder });
  console.log("A stdin patch review produced a constant-size prompt and a content-keyed guide.");
  const guides = join(pullRequest, ".cache", "hunk-review-plugin", "guides");
  const before = (await readdir(guides)).sort();
  assert.equal(before.length, 1, "One review should produce one guide");
  await smoke({ extension: fixture, required: loaded, checkOrder: true, writeGuide: false, workspace: pullRequest, stdin: true, order: stdinOrder });
  assert.deepEqual((await readdir(guides)).sort(), before, "A new stdin session must reuse the guide");
  console.log("A new stdin patch session found and applied the cached guide.");
} finally {
  await rm(pullRequest, { recursive: true, force: true });
}
