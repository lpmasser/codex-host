import type { CodeBuddyRuntimeProfile } from "@codexhost/adapter-codebuddy";
import { harnessCommandCatalogSchema } from "@codexhost/shared-contracts";
import { WORKBUDDY_DISTRIBUTIONS, type WorkBuddyDistribution } from "./distribution.js";

export const WORKBUDDY_ID = WORKBUDDY_DISTRIBUTIONS.global.harnessId;

export const WORKBUDDY_COMMAND_CATALOG = harnessCommandCatalogSchema.parse({
  commands: [
    {
      id: "workbuddy.compact",
      invocation: "/compact",
      localizations: { "zh-CN": { label: "压缩上下文", description: "压缩当前对话上下文" } },
      label: "Compact context",
      description: "Compact the current WorkBuddy Session context",
      argumentMode: "text",
    },
    {
      id: "workbuddy.init",
      invocation: "/init",
      label: "Initialize project guide",
      description: "Generate native project instructions with WorkBuddy",
      argumentMode: "none",
    },
  ],
});

export function workBuddyRuntimeProfile(
  distribution: WorkBuddyDistribution,
): CodeBuddyRuntimeProfile {
  const { harnessId, displayName, configDirectoryEnvironmentVariable, dataFolderName } =
    WORKBUDDY_DISTRIBUTIONS[distribution];
  return {
    harnessId,
    displayName,
    interactionIdPrefix: harnessId,
    // History, subagents and Fork read the same Host key the spawned CLI root is mapped from.
    configDirectoryEnvironmentVariables: [configDirectoryEnvironmentVariable],
    defaultConfigDirectoryName: dataFolderName,
    // WorkBuddy's native PathUtils.compressPath preserves case, dots, spaces and Unicode.
    projectDirectoryName: (cwd) =>
      cwd
        .replace(/[/\\:]/gu, "-")
        .replace(/^-+/u, "")
        .replace(/-+$/u, "")
        .replace(/-+/gu, "-"),
    staticCommandCatalog: WORKBUDDY_COMMAND_CATALOG,
    nativeCommands: true,
    // Verified online on the international CLI 2.137.1. The China CLI 2.147.0 ships the same
    // public `--fork-session` mode and `_codebuddy.ai/session/rollback` extension.
    historyCapabilities: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
  };
}

export const WORKBUDDY_RUNTIME_PROFILE = workBuddyRuntimeProfile("global");
