import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

interface FileIdentity { id: string; path: string }

export function selectSessionId(value: unknown, pid: number, files: readonly FileIdentity[]): string {
  const sessions = (value as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) throw new Error("Invalid Hunk session list");
  const expected = files.map((file) => JSON.stringify([file.id, file.path])).sort();
  const matches = sessions.filter((session) => {
    if (!session || typeof session !== "object" || session.pid !== pid || !Array.isArray(session.files)) return false;
    const actual = session.files.map((file: FileIdentity) => JSON.stringify([file?.id, file?.path])).sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
  if (matches.length !== 1 || typeof matches[0].sessionId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(matches[0].sessionId)) {
    throw new Error("Could not identify this live review session. Check Hunk's session API is available, then copy a fresh prompt.");
  }
  return matches[0].sessionId;
}

export async function liveSessionId(files: readonly FileIdentity[]): Promise<string> {
  // Inside Hunk, execPath is its own runtime executable, never a repo-supplied command.
  const { stdout } = await execute(process.execPath, ["session", "list", "--json"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  return selectSessionId(JSON.parse(stdout), process.pid, files);
}
