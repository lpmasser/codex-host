/** Projects only the applied patches recorded in native tool results. */
import https from "node:https";

import type { HostFileChange } from "@codexhost/harness-adapter";

import { displayPath, isAntigravityFileMutatingTool, toolTargetFile } from "./tool-projection.js";

const TRAJECTORY_PAGE_SIZE = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The current native GENERIC result records applied edits as diff blocks. */
export function nativeToolFileChange(
  toolName: string,
  detail: { parameters?: unknown; output?: unknown },
  cwd: string,
): HostFileChange | null {
  if (!isAntigravityFileMutatingTool(toolName) || typeof detail.output !== "string") return null;
  const target = toolTargetFile(toolName, detail.parameters);
  if (!target) return null;
  const displayed = displayPath(target, cwd);
  if (!displayed) return null;
  const patches = Array.from(
    detail.output.matchAll(/^\[diff_block_start\]\r?\n[\s\S]*?^\[diff_block_end\]/gm),
    (match) =>
      match[0].slice(match[0].indexOf("\n") + 1, -"[diff_block_end]".length).replace(/\n$/, ""),
  );
  if (
    patches.length === 0 ||
    patches.some((patch) => !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(patch)) ||
    !/^[+-]/m.test(patches.join("\n"))
  ) {
    return null;
  }
  const aPath = displayed.absolute ? displayed.path : `a/${displayed.path}`;
  const bPath = displayed.absolute ? displayed.path : `b/${displayed.path}`;
  return {
    path: displayed.path,
    kind: "update",
    unifiedDiff: [
      `diff --git ${aPath} ${bPath}`,
      `--- ${aPath}`,
      `+++ ${bPath}`,
      ...patches,
      "",
    ].join("\n"),
  };
}

function plannerStepThinking(step: unknown): string | null {
  if (!isRecord(step) || step.type !== "CORTEX_STEP_TYPE_PLANNER_RESPONSE") return null;
  const plannerResponse = isRecord(step.plannerResponse) ? step.plannerResponse : null;
  if (!plannerResponse) return null;
  for (const candidate of [
    plannerResponse.thinking,
    plannerResponse.rawThinking,
    plannerResponse.raw_thinking,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/**
 * Reads the thinking text of one `CORTEX_STEP_TYPE_PLANNER_RESPONSE` step out
 * of a `GetCascadeTrajectorySteps` response. `agy` strips `<thought>` blocks
 * from `stream-json` step updates while recording the full thinking text on
 * the trajectory step at `stepIndex`.
 */
export function parseAntigravityStepThinking(
  value: unknown,
  stepIndex: number,
  stepOffset = 0,
): string | null {
  if (!isRecord(value) || !Array.isArray(value.steps)) return null;
  const relativeIndex = stepIndex - stepOffset;
  if (relativeIndex >= 0 && relativeIndex < value.steps.length) {
    const direct = plannerStepThinking(value.steps[relativeIndex]);
    if (direct !== null) return direct;
  }
  for (const step of value.steps) {
    if (isRecord(step) && step.stepIndex === stepIndex) {
      const matched = plannerStepThinking(step);
      if (matched !== null) return matched;
    }
  }
  return null;
}

export function requestAntigravityStepThinking(
  port: number,
  conversationId: string,
  stepIndex: number,
  timeoutMs: number,
): Promise<string | null> {
  const stepOffset = stepIndex >= TRAJECTORY_PAGE_SIZE ? stepIndex : 0;
  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps",
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            resolve(parseAntigravityStepThinking(JSON.parse(body), stepIndex, stepOffset));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end(
      JSON.stringify({
        cascadeId: conversationId,
        ...(stepOffset > 0 ? { stepOffset } : {}),
      }),
    );
  });
}
