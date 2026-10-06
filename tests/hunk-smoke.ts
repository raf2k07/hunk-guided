import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function smoke(extension: string, required: string[], checkOrder = false): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "hunk-review-smoke-"));
  let child: ChildProcess | undefined;
  try {
    if (checkOrder) {
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
      join(root, "tests/fixtures/review.patch"), "--extension", extension];
    // util-linux script supplies a real PTY; all dynamic arguments are quoted.
    const command = `stty rows 40 cols 180; exec ${args.map(shellQuote).join(" ")}`;
    child = spawn("script", ["--quiet", "--return", "--command", command, "/dev/null"], {
      cwd: temporary, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor",
        HOME: temporary, XDG_CONFIG_HOME: temporary, XDG_CACHE_HOME: temporary },
    });
    const running = child;
    let output = "";
    let requestedGuide = false;
    const decoder = new StringDecoder("utf8");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(
        `Hunk sidebar smoke test timed out; missing: ${required.filter((message) => !stripAnsi(output).includes(message)).join(", ")}\n${stripAnsi(output)}`,
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
      const onExit = (code: number | null) => finish(new Error(`Hunk exited early (${code})\n${stripAnsi(output)}`));
      const onData = (chunk: Buffer) => {
        output += decoder.write(chunk);
        if (chunk.includes(Buffer.from("\x1b[6n"))) running.stdin?.write("\x1b[1;1R");
        if (chunk.includes(Buffer.from("\x1b[c"))) running.stdin?.write("\x1b[?1;2c");
        if (checkOrder && !requestedGuide && screenText(output).includes("No validated review guide yet")) {
          requestedGuide = true;
          running.stdin?.write("\x07");
        }
        if (required.every((message) => screenText(output).includes(message))) {
          if (checkOrder) running.stdin?.write("\x05");
          finish();
        }
      };
      running.stdout?.on("data", onData); running.stderr?.on("data", onData);
      running.once("error", onError); running.once("exit", onExit);
    });
    if (checkOrder) {
      const result = JSON.parse(await readFile(join(temporary, "review-order.json"), "utf8"));
      assert.deepEqual(result.files, ["tests/api.test.ts", "src/api.ts"]);
      assert.equal(result.identitiesPreserved, true);
      let sessionPrompt: {
        sessionId?: string;
        identities?: { path: string; fileKey: string; contentIdentity: string }[];
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
      assert.deepEqual(context.reviewFiles, sessionPrompt.identities, "Copied identities must match the real reordered command snapshot");
      assert.deepEqual(context.reviewFiles.map((file: { path: string }) => file.path), result.files);
      assert.ok(context.reviewFiles.every((file: { fileKey: string; contentIdentity: string }) => file.fileKey && file.contentIdentity));
    }
  } finally {
    try { if (child) await stop(child); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

await smoke(root, ["Guided review", "No validated review guide yet", "Copy review prompt"]);
console.log("Hunk 0.23.0 loaded the folder extension and rendered its empty sidebar.");
await smoke(join(root, "tests/fixtures/guide-smoke.ts"), [
  "Guided review", "Authorization workflow smoke test", "Regression coverage",
  "Permission rule", "Test section explanation", "Implementation section explanation",
], true);
console.log("Hunk validated and reordered a guide using real command snapshots and automatically copied its native content identities exactly once through the React pane.");
