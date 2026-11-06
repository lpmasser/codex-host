/**
 * Native Antigravity usage projection.
 *
 * The local Language Server's generator metadata is the only native source of
 * current context occupancy. Step usage describes individual generations;
 * result usage aggregates billing tokens and cannot stand in for context.
 */

import { readFile } from "node:fs/promises";
import https from "node:https";

import type { HostUsage } from "@codexhost/harness-adapter";

import { isRecord, type AntigravityUsage } from "./stream-events.js";

export const GEMINI_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;

const CONTEXT_USAGE_TIMEOUT_MS = 8_000;
const CONTEXT_USAGE_RETRY_MS = 100;

export function safeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function resolveAntigravityContextWindow(modelId?: string, reportedWindow?: number): number {
  if (modelId && /^claude(?:[-_.]|$)/iu.test(modelId)) {
    return CLAUDE_CONTEXT_WINDOW_TOKENS;
  }
  if (!modelId || /^gemini(?:[-_.]|$)/iu.test(modelId)) {
    return GEMINI_CONTEXT_WINDOW_TOKENS;
  }
  return reportedWindow && reportedWindow > 0 ? reportedWindow : GEMINI_CONTEXT_WINDOW_TOKENS;
}

function contextWindowMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const trajectory = isRecord(value.trajectory) ? value.trajectory : value;
  const generatorMetadata = trajectory.generatorMetadata;
  if (!Array.isArray(generatorMetadata)) return null;
  // One entry is appended per generation, so the newest valid metadata trails
  // the array; earlier entries describe pre-compaction generations.
  for (let index = generatorMetadata.length - 1; index >= 0; index -= 1) {
    const entry = generatorMetadata[index];
    if (!isRecord(entry) || !isRecord(entry.chatModel)) continue;
    const chatStartMetadata = entry.chatModel.chatStartMetadata;
    if (!isRecord(chatStartMetadata) || !isRecord(chatStartMetadata.contextWindowMetadata)) {
      continue;
    }
    return chatStartMetadata.contextWindowMetadata;
  }
  return null;
}

/** Parses the real context counters exposed by agy's local Language Server. */
export function parseAntigravityContextUsage(
  value: unknown,
  modelId?: string,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null {
  const metadata = contextWindowMetadata(value);
  if (!metadata) return null;
  const breakdown = isRecord(metadata.tokenBreakdown) ? metadata.tokenBreakdown : null;
  const used = safeToken(
    metadata.estimatedTokensUsed ??
      metadata.estimated_tokens_used ??
      breakdown?.totalTokens ??
      breakdown?.total_tokens,
  );
  const window = safeToken(metadata.maxContextTokens ?? metadata.max_context_tokens);
  if (used === undefined) return null;
  const contextWindowTokens = resolveAntigravityContextWindow(modelId, window);
  return { contextUsedTokens: used, contextWindowTokens };
}

export function requestAntigravityContextUsage(
  port: number,
  conversationId: string,
  timeoutMs: number,
  modelId?: string,
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata",
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
        response.on("error", () => resolve(null));
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            resolve(parseAntigravityContextUsage(JSON.parse(body), modelId));
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
        generatorMetadataOffset: 0,
        includeMessages: false,
      }),
    );
  });
}

export async function antigravityHttpsPort(logPath: string): Promise<number | null> {
  try {
    const log = await readFile(logPath, "utf8");
    const match = log.match(
      /Language server listening on random port at (\d+) for HTTPS \(gRPC\)/iu,
    );
    const port = match ? Number(match[1]) : Number.NaN;
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

export async function pollAntigravityContextUsage(
  logPath: string,
  conversationId: string,
  modelId?: string,
  isDone?: () => boolean,
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  const deadline = Date.now() + CONTEXT_USAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const port = await antigravityHttpsPort(logPath);
    if (port !== null) {
      const usage = await requestAntigravityContextUsage(
        port,
        conversationId,
        CONTEXT_USAGE_RETRY_MS,
        modelId,
      );
      if (usage) return usage;
    }
    if (isDone?.()) break;
    await new Promise<void>((resolve) => setTimeout(resolve, CONTEXT_USAGE_RETRY_MS));
  }
  return null;
}

/**
 * Host usage from one agy usage object, preserving its native billing counters.
 * A step's usage describes one model request, whose prompt (`input_tokens` plus
 * the separate `cache_read_tokens`) estimates the context in use. A result's
 * usage sums every request of the native Conversation, so it carries context
 * only when agy names it. Either is a fallback for the Language Server reading.
 */
export function hostUsage(
  value: AntigravityUsage | undefined,
  modelId: string | undefined,
  scope: "request" | "conversation",
): HostUsage | null {
  if (!value) return null;
  const inputTokens = safeToken(value.input_tokens);
  const outputTokens = safeToken(value.output_tokens);
  const reasoningOutputTokens = safeToken(value.thinking_tokens);
  const totalTokens = safeToken(value.total_tokens);
  const requestPromptTokens =
    scope === "request" && inputTokens !== undefined
      ? inputTokens + (safeToken(value.cache_read_tokens) ?? 0)
      : undefined;
  const contextUsedTokens =
    safeToken(value.context_used_tokens ?? value.estimated_tokens_used) ?? requestPromptTokens;
  const rawWindow = safeToken(value.context_window_tokens ?? value.max_context_tokens);
  const contextWindowTokens =
    contextUsedTokens !== undefined || rawWindow !== undefined
      ? resolveAntigravityContextWindow(modelId, rawWindow)
      : undefined;
  const usage: HostUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextUsedTokens !== undefined &&
    contextWindowTokens !== undefined &&
    contextWindowTokens > 0
      ? { contextUsedTokens, contextWindowTokens }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}
