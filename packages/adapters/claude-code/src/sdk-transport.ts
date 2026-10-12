import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import {
  query,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import type { HarnessAccountSnapshot, HarnessThinkingOptionId } from "@codexhost/shared-contracts";
import {
  parseClaudeSlashCommands,
  type ClaudeSlashCommand,
  type ClaudeSlashCommandSnapshot,
} from "./slash-commands.js";
import { projectClaudeAccountUsage } from "./account-usage.js";

import { resolveClaudeCodeExecutable, withNodeRuntimeOnPath } from "./command.js";
import {
  mergeClaudeModelPickerOptions,
  readClaudeUserModelPicker,
  type ClaudeModelInspectionSnapshot,
} from "./model-catalog.js";
import {
  ClaudeNativeTurnAccumulator,
  parseClaudePlanLimitEvent,
  parseClaudeWorkflowAgents,
} from "./native-message.js";
import { isClaudePermissionMode, type ClaudePermissionMode } from "./permission-modes.js";
import { closeClaudeProcessGroup } from "./process-fence.js";
import {
  claudeThinkingConfiguration,
  claudeThinkingFlagSettings,
  parseClaudeThinkingOptionId,
} from "./thinking-options.js";
import {
  ClaudeUltracodeUnavailableError,
  claudeUltracodeActive,
  claudeUltracodeUnavailableReason,
} from "./ultracode.js";
import {
  type ClaudeApprovalRequest,
  type ClaudeApprovalSuggestionScope,
  type ClaudeSessionEvent,
  type ClaudeInteractionRequest,
  type ClaudeInteractionResponse,
  type ClaudeModelInspector,
  type ClaudePlanLimitEvent,
  type ClaudeQuestion,
  type ClaudeTransportContextUsage,
  type ClaudeTurnTransport,
} from "./transport.js";

const CLIENT_APP = "codexhost-claude-code-adapter/0.0.0";
// Claude Code hides generic SDK entrypoints from its native Session picker. Keep persisted
// CodexHost Sessions discoverable without misidentifying their transport as interactive CLI.
const SESSION_ENTRYPOINT = "codexhost-sdk";
const APPROVAL_TITLE_MAX_LENGTH = 120;
const APPROVAL_DESCRIPTION_MAX_LENGTH = 500;
const DEFAULT_ABORT_TIMEOUT_MS = 2_000;
/** Bounds the Workflow agents kept to name and own agent approvals. */
const WORKFLOW_AGENT_LIMIT = 1_000;
const INTERRUPT_TIMEOUT_MESSAGE = "Claude SDK interrupt timed out";

class PushableInput<T> implements AsyncIterable<T> {
  #closed = false;
  #queue: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];

  push(value: T): void {
    if (this.#closed) throw new Error("Claude SDK input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#queue.push(value);
  }

  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#queue.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

interface PendingInteraction {
  segment: NativeSegment | null;
  /** The native agent that raised the request; a Workflow agent's run owns it like a parent call. */
  agentId?: string;
  controlRequestId: string;
  input: Record<string, unknown>;
  onAbort(): void;
  request: ClaudeInteractionRequest;
  resolve(result: PermissionResult): void;
  suggestions?: PermissionUpdate[];
  signal: AbortSignal;
  toolUseId: string;
}

interface NativeSegment {
  id: number;
  accumulator: ClaudeNativeTurnAccumulator;
  inputIds: string[];
  tools: Map<string, boolean>;
  started: boolean;
}

export interface ClaudeSdkTransportOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  cwd: string;
  sessionId: string;
  openMode: "create" | "resume";
  model?: string;
  thinkingOptionId: HarnessThinkingOptionId;
  permissionMode: ClaudePermissionMode;
  /**
   * Native prerequisite for a later live `bypassPermissions` selection. Callers decide it with
   * `claudeBypassPermissionsAvailable()` because plain root makes Claude Code exit at startup.
   */
  allowDangerouslySkipPermissions?: boolean;
  closeTimeoutMs: number;
  abortTimeoutMs?: number;
  onPermissionModeChanged(permissionMode: ClaudePermissionMode): void;
  onFault(error: unknown): void;
  onPlanLimit(planLimit: ClaudePlanLimitEvent): void;
  queryFactory?: typeof query;
}

export interface ClaudeSdkModelInspectorOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  cwd: string;
  closeTimeoutMs: number;
  queryFactory?: typeof query;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rejectAfter(
  milliseconds: number,
  message: string,
): { promise: Promise<never>; cancel(): void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return {
    promise,
    cancel() {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    },
  };
}

function processExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function permissionModeFromMessage(value: unknown): ClaudePermissionMode | undefined {
  if (
    !isRecord(value) ||
    value.type !== "system" ||
    (value.subtype !== "init" && value.subtype !== "status") ||
    !("permissionMode" in value) ||
    value.permissionMode === undefined
  ) {
    return undefined;
  }
  return isClaudePermissionMode(value.permissionMode) ? value.permissionMode : undefined;
}

function parseContextUsage(value: unknown): ClaudeTransportContextUsage {
  if (!isRecord(value)) throw new Error("Claude SDK context Usage is invalid");
  const usedTokens = value.totalTokens;
  const maxTokens = value.maxTokens;
  const model = value.model;
  if (
    typeof usedTokens !== "number" ||
    !Number.isSafeInteger(usedTokens) ||
    usedTokens < 0 ||
    typeof maxTokens !== "number" ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    typeof model !== "string" ||
    model.trim().length === 0 ||
    model.length > 256
  ) {
    throw new Error("Claude SDK context Usage contains invalid values");
  }
  return { usedTokens, maxTokens, model };
}

function parseQuestions(input: Record<string, unknown>): ClaudeQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) {
    return null;
  }
  const questions: ClaudeQuestion[] = [];
  const questionTexts = new Set<string>();
  for (const value of input.questions) {
    if (!isRecord(value)) return null;
    const question = value.question;
    const header = value.header;
    const multiSelect = value.multiSelect;
    if (
      typeof question !== "string" ||
      question.length === 0 ||
      questionTexts.has(question) ||
      typeof header !== "string" ||
      header.length === 0 ||
      typeof multiSelect !== "boolean" ||
      !Array.isArray(value.options) ||
      value.options.length < 2 ||
      value.options.length > 4
    ) {
      return null;
    }
    const labels = new Set<string>();
    const options = [];
    for (const option of value.options) {
      if (
        !isRecord(option) ||
        typeof option.label !== "string" ||
        option.label.length === 0 ||
        labels.has(option.label) ||
        typeof option.description !== "string"
      ) {
        return null;
      }
      labels.add(option.label);
      options.push({ label: option.label, description: option.description });
    }
    questionTexts.add(question);
    questions.push({ question, header, options, multiSelect });
  }
  return questions;
}

function boundedDisplayText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

const SESSION_PERMISSION_DESTINATIONS = new Set(["session", "cliArg"]);
const PERSISTENT_PERMISSION_DESTINATIONS = new Set([
  "userSettings",
  "projectSettings",
  "localSettings",
]);
const PERMISSION_BEHAVIORS = new Set(["allow", "deny", "ask"]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

function permissionUpdateDestination(value: unknown): "session" | "always" | undefined {
  if (typeof value !== "string") return undefined;
  if (SESSION_PERMISSION_DESTINATIONS.has(value)) return "session";
  if (PERSISTENT_PERMISSION_DESTINATIONS.has(value)) return "always";
  return undefined;
}

function isPermissionUpdate(value: unknown): value is PermissionUpdate {
  if (!isRecord(value) || !permissionUpdateDestination(value.destination)) return false;
  if (value.type === "setMode") {
    return typeof value.mode === "string" && PERMISSION_MODES.has(value.mode);
  }
  if (value.type === "addDirectories" || value.type === "removeDirectories") {
    return (
      Array.isArray(value.directories) &&
      value.directories.every((directory) => typeof directory === "string")
    );
  }
  if (value.type === "addRules" || value.type === "replaceRules" || value.type === "removeRules") {
    return (
      typeof value.behavior === "string" &&
      PERMISSION_BEHAVIORS.has(value.behavior) &&
      Array.isArray(value.rules) &&
      value.rules.every(
        (rule) =>
          isRecord(rule) &&
          typeof rule.toolName === "string" &&
          (rule.ruleContent === undefined || typeof rule.ruleContent === "string"),
      )
    );
  }
  return false;
}

function permissionSuggestionScope(value: unknown): ClaudeApprovalSuggestionScope | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPermissionUpdate)) {
    return undefined;
  }
  return value.some(({ destination }) => permissionUpdateDestination(destination) === "always")
    ? "always"
    : "session";
}

function parseApprovalRequest(
  requestId: string,
  toolName: string,
  options: Parameters<CanUseTool>[2],
  agentLabel?: string,
): ClaudeApprovalRequest | null {
  const toolTitle = [options.title, options.displayName, options.description, toolName]
    .map((value) => boundedDisplayText(value, APPROVAL_TITLE_MAX_LENGTH))
    .find((value): value is string => value !== null);
  if (!toolTitle) return null;
  // Name the Workflow agent asking, since several agents may ask for the same tool at once.
  const title = agentLabel
    ? `${agentLabel}: ${toolTitle}`.slice(0, APPROVAL_TITLE_MAX_LENGTH)
    : toolTitle;
  const description = boundedDisplayText(options.description, APPROVAL_DESCRIPTION_MAX_LENGTH);
  const suggestedScope = permissionSuggestionScope(options.suggestions);
  return {
    type: "approval",
    requestId,
    title,
    ...(description && description !== title ? { description } : {}),
    ...(suggestedScope ? { suggestedScope } : {}),
  };
}

function denied(toolUseId: string, message: string): PermissionResult {
  return {
    behavior: "deny",
    message,
    toolUseID: toolUseId,
    decisionClassification: "user_reject",
  };
}

function allowed(
  toolUseId: string,
  input: Record<string, unknown>,
  suggestions?: PermissionUpdate[],
): PermissionResult {
  return {
    behavior: "allow",
    updatedInput: input,
    toolUseID: toolUseId,
    decisionClassification: suggestions ? "user_permanent" : "user_temporary",
    ...(suggestions ? { updatedPermissions: suggestions } : {}),
  };
}

export class ClaudeSdkTransport implements ClaudeTurnTransport {
  readonly sessionId: string;
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  readonly #abortTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #command: string | undefined;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #input = new PushableInput<SDKUserMessage>();
  readonly #model: string | undefined;
  /** The Model the live Session runs; `undefined` is Claude Code's default Model. */
  #currentModel: string | undefined;
  readonly #onFault: (error: unknown) => void;
  readonly #onPermissionModeChanged: (permissionMode: ClaudePermissionMode) => void;
  readonly #onPlanLimit: (planLimit: ClaudePlanLimitEvent) => void;
  readonly #openMode: "create" | "resume";
  #permissionMode: ClaudePermissionMode;
  readonly #allowDangerouslySkipPermissions: boolean;
  readonly #queryFactory: typeof query;
  #thinkingOptionId: HarnessThinkingOptionId;
  #segment: NativeSegment | null = null;
  #segmentOrdinal = 0;
  #canClearQueued = false;
  #activity: "idle" | "running" | "requires_action" = "idle";
  #eventHandler: ((event: ClaudeSessionEvent) => void | Promise<void>) | null = null;
  readonly #pendingInputs = new Map<string, { resolve(): void; reject(error: Error): void }>();
  readonly #controls = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly #interactions = new Map<string, PendingInteraction>();
  readonly #controlRequestIds = new Set<string>();
  readonly #workflowAgents = new Map<string, { label: string; callId: string }>();
  #closePromise: Promise<void> | null = null;
  #consumeTask: Promise<void> | null = null;
  #stderrTail = "";
  #interactionOrdinal = 0;
  #provider: string | undefined;
  #query: Query | null = null;
  #slashCommands: ClaudeSlashCommand[] | null = null;
  #skillNames: ReadonlySet<string> = new Set();
  #started = false;
  #backgroundTasks = new Set<string>();

  constructor(options: ClaudeSdkTransportOptions) {
    this.sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#model = options.model;
    this.#currentModel = options.model;
    this.#onFault = options.onFault;
    this.#onPermissionModeChanged = options.onPermissionModeChanged;
    this.#onPlanLimit = options.onPlanLimit;
    this.#openMode = options.openMode;
    this.#permissionMode = options.permissionMode;
    this.#allowDangerouslySkipPermissions = options.allowDangerouslySkipPermissions ?? false;
    this.#queryFactory = options.queryFactory ?? query;
    this.#thinkingOptionId = parseClaudeThinkingOptionId(options.thinkingOptionId);
  }

  setEventHandler(handler: (event: ClaudeSessionEvent) => void | Promise<void>): void {
    this.#eventHandler = handler;
  }

  #emit(event: ClaudeSessionEvent): Promise<void> {
    return Promise.resolve(this.#eventHandler?.(event));
  }

  #nativeSegment(): NativeSegment {
    return (this.#segment ??= {
      id: ++this.#segmentOrdinal,
      accumulator: new ClaudeNativeTurnAccumulator(
        this.#provider ? { provider: this.#provider } : {},
      ),
      inputIds: [],
      tools: new Map(),
      started: false,
    });
  }

  async #startSegment(segment: NativeSegment): Promise<void> {
    if (segment.started) return;
    segment.started = true;
    await this.#emit({
      type: "segment.started",
      segmentId: segment.id,
      inputIds: [...segment.inputIds],
    });
  }

  isRunning(): boolean {
    return this.#activity !== "idle" || this.#segment?.started === true;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closePromise) throw new Error("Claude SDK transport is closing");
    const executable = resolveClaudeCodeExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    const thinking = claudeThinkingConfiguration(this.#thinkingOptionId);
    const activeQuery = this.#queryFactory({
      prompt: this.#input,
      options: {
        cwd: this.#cwd,
        ...(this.#openMode === "resume"
          ? { resume: this.sessionId }
          : { sessionId: this.sessionId }),
        ...(this.#model ? { model: this.#model } : {}),
        // Adaptive Thinking is redacted by default: the API streams `thinking_delta`
        // frames carrying only token estimates and empty text, so no Reasoning Item
        // would ever start. Summarized display is the official channel for readable
        // Thinking and is what Claude Code's own TUI renders.
        thinking: thinking.enabled
          ? { type: "adaptive", display: "summarized" }
          : { type: "disabled" },
        ...(thinking.effort ? { effort: thinking.effort } : {}),
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user"],
        permissionMode: this.#permissionMode,
        ...(this.#allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool: (toolName, input, options) => this.#canUseTool(toolName, input, options),
        persistSession: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        env: withNodeRuntimeOnPath({
          ...this.#environment,
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,
          CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        }),
        spawnClaudeCodeProcess: (options) => this.#spawn(options),
      },
    });
    this.#query = activeQuery;
    try {
      const initialization = await activeQuery.initializationResult();
      const activity = (initialization as { session_state?: unknown }).session_state;
      if (activity === "idle" || activity === "running" || activity === "requires_action") {
        this.#activity = activity;
        await this.#emit({ type: "activity.changed", activity });
      } else {
        throw new Error("Claude CLI does not report native Session activity");
      }
      this.#slashCommands = parseClaudeSlashCommands(
        (initialization as { commands?: unknown }).commands,
      );
      this.#provider = (await activeQuery.accountInfo().catch(() => undefined))?.apiProvider;
      if (thinking.ultracode) {
        // Ultracode is a session-scoped flag setting. It must be confirmed before the first
        // message: Claude Code accepts the request even when the Session cannot honor it.
        await activeQuery.applyFlagSettings(claudeThinkingFlagSettings(thinking, null));
        await this.#verifyUltracode(activeQuery);
      }
    } catch (error) {
      activeQuery.close();
      this.#query = null;
      throw error;
    }
    this.#started = true;
    this.#consumeTask = this.#consume(activeQuery);
  }

  slashCommands(): ClaudeSlashCommandSnapshot | null {
    if (!this.#started || this.#slashCommands === null) return null;
    return { commands: this.#slashCommands, skillNames: this.#skillNames };
  }

  #observeSlashCommands(message: unknown): void {
    if (!isRecord(message) || message.type !== "system") return;
    if (message.subtype === "init" && Array.isArray(message.skills)) {
      this.#skillNames = new Set(
        message.skills.filter((name): name is string => typeof name === "string"),
      );
    } else if (message.subtype === "commands_changed") {
      this.#slashCommands = parseClaudeSlashCommands(message.commands);
    }
  }

  async getContextUsage(): Promise<ClaudeTransportContextUsage | null> {
    const activeQuery = this.#query;
    if (!this.#started || !activeQuery) return null;
    return parseContextUsage(await activeQuery.getContextUsage());
  }

  getPermissionMode(): ClaudePermissionMode {
    if (!this.#started || !this.#query) throw new Error("Claude SDK transport is not started");
    return this.#permissionMode;
  }

  async setModel(model?: string): Promise<void> {
    const activeQuery = this.#query;
    if (!this.#started || !activeQuery) throw new Error("Claude SDK transport is not started");
    const thinking = claudeThinkingConfiguration(this.#thinkingOptionId);
    const previousModel = this.#currentModel;
    await activeQuery.setModel(model);
    if (thinking.ultracode) {
      try {
        await activeQuery.applyFlagSettings(claudeThinkingFlagSettings(thinking, thinking));
        await this.#verifyUltracode(activeQuery);
      } catch (error) {
        // Ultracode stays selected, so the Model it cannot run on is rejected instead.
        await this.#restoreOrFault(async () => {
          await activeQuery.setModel(previousModel);
          await activeQuery.applyFlagSettings(claudeThinkingFlagSettings(thinking, null));
          // A write Claude Code accepts may still not take effect; confirm the restored state.
          await this.#verifyUltracode(activeQuery);
        });
        throw error;
      }
    }
    this.#currentModel = model;
  }

  async setThinkingOption(thinkingOptionId: HarnessThinkingOptionId): Promise<void> {
    const activeQuery = this.#query;
    if (!this.#started || !activeQuery) throw new Error("Claude SDK transport is not started");
    const id = parseClaudeThinkingOptionId(thinkingOptionId);
    const previous = claudeThinkingConfiguration(this.#thinkingOptionId);
    const thinking = claudeThinkingConfiguration(id);
    await activeQuery.applyFlagSettings(claudeThinkingFlagSettings(thinking, previous));
    if (thinking.ultracode) {
      try {
        await this.#verifyUltracode(activeQuery);
      } catch (error) {
        // Restore the confirmed selection, including clearing the requested Ultracode flag.
        await this.#restoreOrFault(async () => {
          await activeQuery.applyFlagSettings(claudeThinkingFlagSettings(previous, thinking));
          await (previous.ultracode
            ? this.#verifyUltracode(activeQuery)
            : this.#verifyUltracodeOff(activeQuery));
        });
        throw error;
      }
    }
    this.#thinkingOptionId = id;
  }

  /** A failed restore leaves the native Model or Thinking state unknown; stop the Session. */
  async #restoreOrFault(restore: () => Promise<void>): Promise<void> {
    try {
      await restore();
    } catch (error) {
      this.#onFault(error);
    }
  }

  /**
   * Claude Code accepts an Ultracode request even when the Session cannot honor it, so the
   * effective state is read back from the native Session settings. Fails closed.
   */
  async #verifyUltracode(activeQuery: Query): Promise<void> {
    const reason = claudeUltracodeUnavailableReason(
      await this.#readSettings(activeQuery),
      this.#environment,
    );
    if (reason) throw new ClaudeUltracodeUnavailableError(reason);
  }

  /** Confirms a restored selection without Ultracode left it off. */
  async #verifyUltracodeOff(activeQuery: Query): Promise<void> {
    if (claudeUltracodeActive(await this.#readSettings(activeQuery))) {
      throw new Error("Claude Code kept Ultracode on after it was cleared");
    }
  }

  async #readSettings(activeQuery: Query): Promise<unknown> {
    // `getSettings` is a native control request the SDK implements without a public type.
    const getSettings = (activeQuery as unknown as { getSettings?: () => Promise<unknown> })
      .getSettings;
    try {
      if (typeof getSettings !== "function") throw new Error("Claude SDK cannot read settings");
      return await getSettings.call(activeQuery);
    } catch {
      throw new ClaudeUltracodeUnavailableError("unverifiable");
    }
  }

  async setPermissionMode(permissionMode: ClaudePermissionMode): Promise<void> {
    const activeQuery = this.#query;
    if (!this.#started || !activeQuery) throw new Error("Claude SDK transport is not started");
    await activeQuery.setPermissionMode(permissionMode);
    this.#permissionMode = permissionMode;
  }

  submitInput(text: string, messageId: string, priority: "next" | "later"): Promise<void> {
    if (this.#closePromise || !this.#started || !this.#query) {
      return Promise.reject(new Error("Claude SDK transport is not started"));
    }
    const timeout = rejectAfter(
      10_000,
      "Claude input acceptance could not be confirmed; it may still execute",
    );
    const accepted = new Promise<void>((resolve, reject) => {
      this.#pendingInputs.set(messageId, { resolve, reject });
    });
    this.#input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: messageId as `${string}-${string}-${string}-${string}-${string}`,
      origin: { kind: "human" },
      priority,
    });
    return Promise.race([accepted, timeout.promise]).finally(() => {
      timeout.cancel();
      this.#pendingInputs.delete(messageId);
    });
  }

  async cancelInput(messageId: string): Promise<boolean> {
    if (this.#closePromise) throw new Error("Claude SDK transport is closing");
    const response = await this.#control({
      subtype: "cancel_async_message",
      message_uuid: messageId,
    });
    if (!isRecord(response) || typeof response.cancelled !== "boolean") {
      throw new Error("Claude returned an invalid input cancellation receipt");
    }
    return response.cancelled;
  }

  /** The SDK owns ordinary RPCs; this narrowly owns the missing native queue operation. */
  #control(
    request:
      | { subtype: "cancel_async_message"; message_uuid: string }
      | { subtype: "interrupt"; cancel_queued: true },
  ): Promise<unknown> {
    const child = this.#children[0];
    if (!child || !this.#query)
      return Promise.reject(new Error("Claude SDK transport is not running"));
    const requestId = `codexhost-control-${randomUUID()}`;
    const timeout = rejectAfter(
      this.#abortTimeoutMs,
      "Claude input cancellation was not confirmed",
    );
    const response = new Promise<unknown>((resolve, reject) => {
      this.#controls.set(requestId, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n",
        (error) => {
          if (error) reject(error);
        },
      );
    });
    return Promise.race([response, timeout.promise]).finally(() => {
      timeout.cancel();
      this.#controls.delete(requestId);
    });
  }

  respondToInteraction(response: ClaudeInteractionResponse): Promise<void> {
    const pending = this.#interactions.get(response.requestId);
    if (!pending?.segment) {
      return Promise.reject(new Error("Claude SDK Interaction is not pending"));
    }
    if (response.type === "approval") {
      if (pending.request.type !== "approval" && pending.request.type !== "planApproval") {
        return Promise.reject(new Error("Claude SDK Interaction response type does not match"));
      }
      let result: PermissionResult;
      if (response.decision === "deny") {
        result = denied(
          pending.toolUseId,
          pending.request.type === "planApproval"
            ? "User chose to stay in plan mode. Do not begin implementation."
            : "User denied the Tool request",
        );
      } else if (response.decision === "allowOnce") {
        if (pending.request.type === "planApproval" && !pending.request.plan) {
          return Promise.reject(new Error("Claude SDK plan text is unavailable for approval"));
        }
        result = allowed(pending.toolUseId, pending.input);
      } else {
        const requestedScope = response.decision === "allowForSession" ? "session" : "always";
        if (
          pending.request.type !== "approval" ||
          pending.request.suggestedScope !== requestedScope ||
          !pending.suggestions
        ) {
          return Promise.reject(new Error("Claude SDK Approval scope is not pending"));
        }
        result = allowed(pending.toolUseId, pending.input, pending.suggestions);
      }
      this.#settleInteraction(pending, result, "responded");
      return Promise.resolve();
    }
    if (pending.request.type !== "question") {
      return Promise.reject(new Error("Claude SDK Interaction response type does not match"));
    }
    if ("cancelled" in response) {
      this.#settleInteraction(
        pending,
        denied(pending.toolUseId, "User cancelled the Question"),
        "cancelled",
      );
      return Promise.resolve();
    }
    const questionTexts = new Set(pending.request.questions.map(({ question }) => question));
    const answerEntries = Object.entries(response.answers);
    if (
      answerEntries.length !== questionTexts.size ||
      answerEntries.some(
        ([question, answer]) => !questionTexts.has(question) || answer.length === 0,
      )
    ) {
      return Promise.reject(new Error("Claude SDK Question answers do not match the request"));
    }
    this.#settleInteraction(
      pending,
      {
        behavior: "allow",
        updatedInput: { ...pending.input, answers: { ...response.answers } },
        toolUseID: pending.toolUseId,
        decisionClassification: "user_temporary",
      },
      "responded",
    );
    return Promise.resolve();
  }

  async abort(segmentId: number): Promise<{ stillQueued: string[] | null }> {
    const segment = this.#segment;
    const activeQuery = this.#query;
    if (!segment?.started || segment.id !== segmentId || !activeQuery) {
      throw new Error("Claude SDK transport has no matching execution");
    }
    segment.accumulator.requestCancel();
    const timeout = rejectAfter(this.#abortTimeoutMs, INTERRUPT_TIMEOUT_MESSAGE);
    try {
      const receipt = await Promise.race([activeQuery.interrupt(), timeout.promise]);
      return { stillQueued: receipt?.still_queued ?? null };
    } catch (error) {
      await this.close();
      throw error instanceof Error ? error : new Error(INTERRUPT_TIMEOUT_MESSAGE);
    } finally {
      timeout.cancel();
    }
  }

  async #stopRequest(request: Promise<unknown>, message: string): Promise<void> {
    const timeout = rejectAfter(this.#abortTimeoutMs, message);
    try {
      await Promise.race([request, timeout.promise]);
    } finally {
      timeout.cancel();
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  /**
   * The call that owns a request: its own Tool call when this Segment saw it, else the Workflow
   * call of the agent asking. Undefined while this Segment has not seen the owner yet.
   */
  #interactionOwner(pending: PendingInteraction, segment: NativeSegment): string | undefined {
    if (segment.tools.has(pending.toolUseId)) return pending.toolUseId;
    return pending.agentId ? this.#workflowAgents.get(pending.agentId)?.callId : undefined;
  }

  #routeInteraction(pending: PendingInteraction, segment: NativeSegment, owner: string): void {
    if (segment.tools.get(owner)) {
      pending.segment = segment;
      void this.#emit({
        type: "segment.event",
        segmentId: segment.id,
        event: { type: "interaction.requested", request: pending.request },
      }).catch(this.#onFault);
    } else {
      this.#settleInteraction(
        pending,
        denied(pending.toolUseId, "Claude Tool has no live parent execution"),
        "cancelled",
      );
    }
  }

  #canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const validToolName = boundedDisplayText(toolName, APPROVAL_TITLE_MAX_LENGTH);
    if (
      this.#closePromise ||
      !validToolName ||
      typeof options.requestId !== "string" ||
      options.requestId.length === 0 ||
      typeof options.toolUseID !== "string" ||
      options.toolUseID.length === 0 ||
      options.signal.aborted ||
      this.#controlRequestIds.has(options.requestId)
    ) {
      return Promise.resolve(
        denied(options.toolUseID, "Claude Tool permission request is invalid"),
      );
    }

    const agentId =
      typeof options.agentID === "string" && options.agentID.length > 0
        ? options.agentID
        : undefined;
    this.#interactionOrdinal += 1;
    const requestId = `claude-${toolName === "AskUserQuestion" ? "question" : "approval"}-${this.#interactionOrdinal}`;
    let request: ClaudeInteractionRequest | null;
    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input);
      request = questions ? { type: "question", requestId, questions } : null;
    } else if (toolName === "ExitPlanMode") {
      request = {
        type: "planApproval",
        requestId,
        plan: typeof input.plan === "string" && input.plan.trim().length > 0 ? input.plan : null,
      };
    } else {
      request = parseApprovalRequest(
        requestId,
        toolName,
        options,
        agentId ? this.#workflowAgents.get(agentId)?.label : undefined,
      );
    }
    if (!request) {
      return Promise.resolve(
        denied(options.toolUseID, "Claude Tool permission request is invalid"),
      );
    }

    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingInteraction = {
        segment: null,
        ...(agentId ? { agentId } : {}),
        controlRequestId: options.requestId,
        input,
        request,
        resolve,
        signal: options.signal,
        ...(request.type === "approval" && request.suggestedScope && options.suggestions
          ? { suggestions: options.suggestions }
          : {}),
        toolUseId: options.toolUseID,
        onAbort: () => {
          this.#settleInteraction(
            pending,
            denied(
              pending.toolUseId,
              pending.request.type === "question"
                ? "Claude Question was interrupted"
                : "Claude Tool approval was interrupted",
            ),
            "cancelled",
          );
        },
      };
      this.#interactions.set(request.requestId, pending);
      this.#controlRequestIds.add(options.requestId);
      options.signal.addEventListener("abort", pending.onAbort, { once: true });
      const segment = this.#segment;
      const owner = segment ? this.#interactionOwner(pending, segment) : undefined;
      if (segment && owner !== undefined) this.#routeInteraction(pending, segment, owner);
    });
  }

  #settleInteraction(
    pending: PendingInteraction,
    result: PermissionResult,
    reason: "responded" | "cancelled" | "superseded",
  ): void {
    if (!this.#interactions.delete(pending.request.requestId)) return;
    this.#controlRequestIds.delete(pending.controlRequestId);
    pending.signal.removeEventListener("abort", pending.onAbort);
    if (pending.segment)
      void this.#emit({
        type: "segment.event",
        segmentId: pending.segment.id,
        event: { type: "interaction.closed", requestId: pending.request.requestId, reason },
      }).catch(this.#onFault);
    pending.resolve(result);
  }

  #closeInteractions(segment: NativeSegment | null, reason: "cancelled" | "superseded"): void {
    for (const pending of [...this.#interactions.values()]) {
      if (segment && pending.segment !== segment) continue;
      this.#settleInteraction(
        pending,
        denied(
          pending.toolUseId,
          pending.request.type === "question"
            ? "Claude Question is no longer pending"
            : "Claude Tool approval is no longer pending",
        ),
        reason,
      );
    }
  }

  async #close(): Promise<void> {
    this.#rejectPendingInputs();
    const failures: unknown[] = [];
    this.#closeInteractions(null, "cancelled");
    if (
      this.#canClearQueued &&
      this.#query &&
      this.#children[0] &&
      !processExited(this.#children[0])
    ) {
      try {
        await this.#control({ subtype: "interrupt", cancel_queued: true });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      const timeout = rejectAfter(this.#closeTimeoutMs, "Claude background tasks did not stop");
      try {
        await Promise.race([this.#stopBackgroundTasks(), timeout.promise]);
      } finally {
        timeout.cancel();
      }
    } catch (error) {
      // Confirmed process-tree shutdown below supersedes a missing task terminal. Without
      // an owned process, closing the SDK stream alone cannot prove the task stopped.
      if (!this.#children.some((child) => child.pid !== undefined)) failures.push(error);
    }
    const stopOwnedProcesses = async (): Promise<void> => {
      const stopped = await Promise.allSettled(
        this.#children.map((child) => closeClaudeProcessGroup(child, this.#closeTimeoutMs)),
      );
      for (const result of stopped) if (result.status === "rejected") failures.push(result.reason);
    };
    // taskkill needs a living root to enumerate the Windows tree. Unix groups remain addressable
    // after their root exits, so let the SDK initiate its native cleanup first there.
    if (process.platform === "win32") await stopOwnedProcesses();
    this.#input.end();
    try {
      this.#query?.close();
    } catch (error) {
      failures.push(error);
    }
    if (process.platform !== "win32") await stopOwnedProcesses();
    const exitTimeout = rejectAfter(this.#closeTimeoutMs, "Claude SDK process did not exit");
    try {
      await Promise.race([
        Promise.all(this.#children.map((child) => this.#waitForExit(child))),
        exitTimeout.promise,
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      exitTimeout.cancel();
    }
    const drainTimeout = rejectAfter(this.#closeTimeoutMs, "Claude SDK output did not drain");
    try {
      await Promise.race([
        this.#consumeTask?.catch(() => undefined) ?? Promise.resolve(),
        drainTimeout.promise,
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      drainTimeout.cancel();
    }
    this.#query = null;
    this.#segment = null;
    if (failures.length > 0)
      throw new AggregateError(failures, "Claude SDK shutdown could not be confirmed");
  }

  hasBackgroundTasks(): boolean {
    return this.#backgroundTasks.size > 0;
  }

  /** The native `task_notification` that follows reports the stopped task. */
  async stopBackgroundTask(taskId: string): Promise<void> {
    if (!this.#query) throw new Error("Claude SDK transport is not running");
    await this.#stopRequest(this.#query.stopTask(taskId), "Claude background task stop timed out");
  }

  async stopTasks(taskIds: readonly string[]): Promise<void> {
    const activeQuery = this.#query;
    if (!activeQuery) throw new Error("Claude SDK transport is not running");
    const ids = [...new Set(taskIds)];
    await Promise.all(
      ids.map(async (taskId) => {
        try {
          await this.#stopRequest(
            activeQuery.stopTask(taskId),
            "Claude background task stop timed out",
          );
        } catch (error) {
          // The task ended before the stop arrived.
          if (this.#backgroundTasks.has(taskId)) throw error;
        }
      }),
    );
    // A control receipt alone is not a task terminal; wait until Claude Code reports each stop.
    const deadline = Date.now() + this.#abortTimeoutMs;
    while (ids.some((taskId) => this.#backgroundTasks.has(taskId))) {
      if (Date.now() >= deadline || this.#query !== activeQuery) {
        throw new Error("Claude background task stop was not confirmed");
      }
      await delay(10);
    }
  }

  async #stopBackgroundTasks(): Promise<void> {
    const requested = new Set<string>();
    const deadline = Date.now() + this.#closeTimeoutMs;
    while (this.#backgroundTasks.size > 0) {
      if (Date.now() >= deadline || !this.#query)
        throw new Error("Claude background tasks remain active");
      for (const id of this.#backgroundTasks) {
        if (requested.has(id)) continue;
        requested.add(id);
        await this.#query.stopTask(id);
      }
      // A control receipt alone is not a task terminal; consume its native stopped notification.
      if (this.#backgroundTasks.size > 0) await delay(10);
    }
  }

  #rejectPendingInputs(): void {
    const error = new Error("Claude SDK transport closed before input acceptance was confirmed");
    for (const pending of this.#pendingInputs.values()) pending.reject(error);
    this.#pendingInputs.clear();
    for (const pending of this.#controls.values()) pending.reject(error);
    this.#controls.clear();
  }

  async #observeInputLifecycle(message: unknown): Promise<void> {
    if (
      !isRecord(message) ||
      message.type !== "command_lifecycle" ||
      typeof message.command_uuid !== "string"
    )
      return;
    const messageId = message.command_uuid;
    if (message.state === "queued") {
      this.#pendingInputs.get(messageId)?.resolve();
    } else if (message.state === "started") {
      const segment = this.#nativeSegment();
      segment.inputIds.push(messageId);
      if (segment.started)
        await this.#emit({ type: "input.started", segmentId: segment.id, messageId });
    } else if (message.state === "cancelled") {
      this.#pendingInputs
        .get(messageId)
        ?.reject(new Error("Claude input was cancelled before acceptance"));
      await this.#emit({ type: "input.cancelled", messageId });
    }
  }

  #observeBackgroundTasks(message: unknown): void {
    if (!isRecord(message) || message.type !== "system") return;
    if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
      this.#backgroundTasks = new Set(
        message.tasks.flatMap((task) =>
          isRecord(task) && typeof task.task_id === "string" ? [task.task_id] : [],
        ),
      );
    } else if (message.subtype === "task_started" && typeof message.task_id === "string") {
      this.#backgroundTasks.add(message.task_id);
    } else if (
      message.subtype === "task_notification" &&
      typeof message.task_id === "string" &&
      ["completed", "failed", "stopped"].includes(String(message.status))
    ) {
      this.#backgroundTasks.delete(message.task_id);
    }
  }

  /** Remembers Workflow agents so their approvals name the agent and reach the run's owner. */
  #observeWorkflowAgents(message: unknown): void {
    if (
      !isRecord(message) ||
      message.type !== "system" ||
      message.subtype !== "task_progress" ||
      typeof message.tool_use_id !== "string"
    ) {
      return;
    }
    for (const agent of parseClaudeWorkflowAgents(message.workflow_progress) ?? []) {
      if (!agent.agentId) continue;
      if (
        !this.#workflowAgents.has(agent.agentId) &&
        this.#workflowAgents.size >= WORKFLOW_AGENT_LIMIT
      ) {
        const oldest = this.#workflowAgents.keys().next();
        if (!oldest.done) this.#workflowAgents.delete(oldest.value);
      }
      this.#workflowAgents.set(agent.agentId, {
        label: agent.label,
        callId: message.tool_use_id,
      });
    }
  }

  async #consume(activeQuery: Query): Promise<void> {
    try {
      for await (const message of activeQuery) {
        this.#observeBackgroundTasks(message);
        this.#observeWorkflowAgents(message);
        this.#observeSlashCommands(message);
        const permissionMode = permissionModeFromMessage(message);
        if (permissionMode && permissionMode !== this.#permissionMode) {
          this.#permissionMode = permissionMode;
          this.#onPermissionModeChanged(permissionMode);
        }
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          !("parent_tool_use_id" in message && message.parent_tool_use_id)
        ) {
          if (!message.capabilities?.includes("msg_lifecycle_v1"))
            throw new Error("Claude CLI does not support input lifecycle events");
          this.#canClearQueued = message.capabilities.includes("interrupt_cancel_queued_v1");
        }
        const planLimit = parseClaudePlanLimitEvent(message);
        if (planLimit) this.#onPlanLimit(planLimit);
        if (message.type === "system" && message.subtype === "session_state_changed") {
          this.#activity = message.state;
          await this.#emit({ type: "activity.changed", activity: message.state });
          continue;
        }
        await this.#observeInputLifecycle(message);
        const segment = this.#nativeSegment();
        if (message.type === "assistant" && typeof message.parent_tool_use_id === "string") {
          const parent = segment.tools.get(message.parent_tool_use_id) === true;
          for (const block of message.message.content) {
            if (block.type === "tool_use") segment.tools.set(block.id, parent);
          }
        }
        const interpreted = segment.accumulator.consume(message);
        for (const event of interpreted.events) {
          // Task levels, settlements, Workflow run progress and model request usage belong to
          // the Session, not a Segment: a launched run keeps reporting after its Root Segment.
          if (
            event.type === "subagents.live" ||
            event.type === "subagent.settled" ||
            event.type === "workflow.updated" ||
            event.type === "workflow.activity" ||
            event.type === "usage.request"
          ) {
            await this.#emit({ type: "thread.event", event });
            continue;
          }
          if (event.type === "segment.started") {
            await this.#startSegment(segment);
            continue;
          }
          if (event.type !== "usage.result") await this.#startSegment(segment);
          if (
            event.type === "tool.started" ||
            event.type === "subagent.started" ||
            event.type === "workflow.started"
          )
            segment.tools.set(event.callId, true);
          if (segment.started)
            await this.#emit({ type: "segment.event", segmentId: segment.id, event });
          if (event.type === "tool.completed") segment.tools.delete(event.callId);
        }
        for (const pending of this.#interactions.values()) {
          const owner = pending.segment ? undefined : this.#interactionOwner(pending, segment);
          if (owner !== undefined) this.#routeInteraction(pending, segment, owner);
        }
        if (
          message.type === "user" &&
          message.parent_tool_use_id &&
          Array.isArray(message.message.content)
        ) {
          for (const block of message.message.content)
            if (block.type === "tool_result") segment.tools.delete(block.tool_use_id);
        }
        if (interpreted.terminal) {
          this.#closeInteractions(segment, "superseded");
          // A failed native result without any preceding output must still be visible.
          if (!segment.started && interpreted.terminal.status !== "succeeded")
            await this.#startSegment(segment);
          if (segment.started)
            await this.#emit({
              type: "segment.completed",
              segmentId: segment.id,
              result: interpreted.terminal,
            });
          this.#segment = null;
        }
      }
      if (!this.#closePromise) throw new Error("Claude SDK Query ended unexpectedly");
    } catch (error) {
      this.#closeInteractions(null, "cancelled");
      this.#rejectPendingInputs();
      this.#segment = null;
      if (!this.#closePromise) this.#onFault(error);
    }
  }

  #spawn(options: SpawnOptions): ChildProcessWithoutNullStreams {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.includes("codexhost-control-") || !line.includes("control_response")) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(value) || value.type !== "control_response" || !isRecord(value.response))
        return;
      const response = value.response;
      if (typeof response.request_id !== "string") return;
      const pending = this.#controls.get(response.request_id);
      if (!pending) return;
      if (response.subtype === "success") pending.resolve(response.response);
      else
        pending.reject(
          new Error(
            typeof response.error === "string"
              ? response.error
              : "Claude input cancellation failed",
          ),
        );
    });
    this.#children.push(child);
    return child;
  }

  #waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (processExited(child)) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }
}

export class ClaudeSdkModelInspector implements ClaudeModelInspector {
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  #stderrTail = "";
  readonly #closeTimeoutMs: number;
  readonly #command: string | undefined;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #input = new PushableInput<SDKUserMessage>();
  readonly #queryFactory: typeof query;
  #closePromise: Promise<void> | null = null;
  #query: Query | null = null;

  get stderrTail(): string {
    return this.#stderrTail;
  }

  constructor(options: ClaudeSdkModelInspectorOptions) {
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#command = options.command;
    this.#cwd = options.cwd;
    this.#environment = options.environment ?? process.env;
    this.#queryFactory = options.queryFactory ?? query;
  }

  #createQuery(): Query {
    if (this.#closePromise) throw new Error("Claude SDK Model inspector is closing");
    const executable = resolveClaudeCodeExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    const activeQuery = this.#queryFactory({
      prompt: this.#input,
      options: {
        cwd: this.#cwd,
        pathToClaudeCodeExecutable: executable,
        settingSources: ["user"],
        permissionMode: "default",
        tools: [],
        persistSession: false,
        includePartialMessages: false,
        env: withNodeRuntimeOnPath({
          ...this.#environment,
          CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        }),
        spawnClaudeCodeProcess: (options) => this.#spawn(options),
      },
    });
    this.#query = activeQuery;
    return activeQuery;
  }

  async inspectAccount(): Promise<HarnessAccountSnapshot | null> {
    const timeout = rejectAfter(10_000, "Claude SDK account inspection timed out");
    try {
      const activeQuery = this.#createQuery();
      return await Promise.race([
        (async () => {
          await activeQuery.initializationResult();
          const getUsage = activeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
          if (typeof getUsage !== "function") return null;
          const usage = await getUsage.call(activeQuery);
          if (!usage.rate_limits_available || !usage.rate_limits) return null;
          const account = await activeQuery.accountInfo();
          return projectClaudeAccountUsage(usage, account);
        })(),
        timeout.promise,
      ]);
    } finally {
      timeout.cancel();
      await this.close();
    }
  }

  async inspect(): Promise<ClaudeModelInspectionSnapshot> {
    const activeQuery = this.#createQuery();
    try {
      const initialized = await activeQuery.initializationResult();
      const candidate = activeQuery as unknown as Record<string, unknown>;
      const canSelectModel =
        Array.isArray(initialized.models) && typeof candidate.setModel === "function";
      const canSelectPermissionMode = typeof candidate.setPermissionMode === "function";
      const modelPicker = await readClaudeUserModelPicker(this.#environment);
      return {
        models: mergeClaudeModelPickerOptions(initialized.models, modelPicker),
        canSelectModel,
        canSelectPermissionMode,
      };
    } finally {
      await this.close();
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#input.end();
    this.#query?.close();
    for (const child of this.#children) {
      if (!processExited(child)) child.kill("SIGTERM");
    }
    await Promise.race([
      Promise.all(this.#children.map((child) => this.#waitForExit(child))),
      delay(this.#closeTimeoutMs),
    ]);
    for (const child of this.#children) {
      if (!processExited(child)) child.kill("SIGKILL");
    }
    this.#query = null;
  }

  #spawn(options: SpawnOptions): ChildProcessWithoutNullStreams {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });
    this.#children.push(child);
    return child;
  }

  #waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (processExited(child)) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }
}
