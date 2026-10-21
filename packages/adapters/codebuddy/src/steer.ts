import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `session/steer` exists from 2.134.0. The `{steered}` acceptance receipt, which
 * `turn.steer` needs before it can return `accepted`, exists from 2.143.1.
 */
export const CODEBUDDY_STEER_MIN_VERSION = "2.143.1";

export interface CodeBuddySteerResult {
  steered: boolean;
  reason?: string;
}

export function compareCodeBuddyVersion(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part));
  const b = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Product versions are unprefixed semver. A leading `v` is Node or Electron, not CodeBuddy. */
export function parseCodeBuddyProductVersion(output: string): string | null {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(line);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function codeBuddySupportsSteer(version: string | null | undefined): boolean {
  return (
    typeof version === "string" &&
    compareCodeBuddyVersion(version, CODEBUDDY_STEER_MIN_VERSION) >= 0
  );
}

export async function probeCodeBuddyProductVersion(
  command: string,
  bundledCliPath: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 3_000,
): Promise<string | null> {
  const args = bundledCliPath ? [bundledCliPath, "--version"] : ["--version"];
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 512,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    return parseCodeBuddyProductVersion(stdout);
  } catch {
    return null;
  }
}
