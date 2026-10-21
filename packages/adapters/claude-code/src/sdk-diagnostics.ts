import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

type Fields = Record<string, unknown>;

function record(value: unknown): Fields {
  return typeof value === "object" && value !== null ? (value as Fields) : {};
}

/** Only protocol identifiers/enums, never text, inputs, results or error messages. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.:-]{1,128}$/u.test(value) ? value : undefined;
}

/** Adapter-owned metadata, using the Host's existing bounded stderr log. */
export class ClaudeSdkDiagnostics {
  readonly #transportId = randomUUID();
  readonly #startedAt = performance.now();
  #sequence = 0;

  constructor(
    readonly sessionId: string,
    readonly write: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
  ) {}

  event(event: string, fields: Fields = {}): void {
    try {
      this.write(
        `[claude-sdk] ${JSON.stringify({
          time: new Date().toISOString(),
          transportId: this.#transportId,
          sessionId: this.sessionId,
          seq: ++this.#sequence,
          elapsedMs: Math.round(performance.now() - this.#startedAt),
          event,
          ...fields,
        })}\n`,
      );
    } catch {
      // Diagnostics must not change input acceptance or native control handling.
    }
  }

  message(event: string, value: unknown, fields: Fields = {}): void {
    const message = record(value);
    const type = message.type;
    const metadata: Fields = { type };
    if (type === "control_request") {
      const request = record(message.request);
      metadata.requestId = identifier(message.request_id);
      metadata.subtype = identifier(request.subtype);
      metadata.detail = identifier(request.detail);
      if (request.cancel_queued === true) metadata.cancelQueued = true;
      metadata.messageId = identifier(request.message_uuid);
      metadata.toolUseId = identifier(request.tool_use_id);
    } else if (type === "control_response") {
      const response = record(message.response);
      metadata.requestId = identifier(response.request_id);
      metadata.subtype = identifier(response.subtype);
      const receipt = record(response.response);
      metadata.state = identifier(receipt.session_state);
      if (Array.isArray(receipt.still_queued)) metadata.stillQueued = receipt.still_queued.length;
    } else if (type === "control_cancel_request") {
      metadata.requestId = identifier(message.request_id);
    } else if (type === "command_lifecycle") {
      metadata.messageId = identifier(message.command_uuid);
      metadata.state = identifier(message.state);
    } else if (type === "user") {
      metadata.messageId = identifier(message.uuid);
      metadata.priority = identifier(message.priority);
    } else if (
      type === "system" &&
      (message.subtype === "init" || message.subtype === "session_state_changed")
    ) {
      metadata.subtype = message.subtype;
      metadata.state = identifier(message.state);
      metadata.cliVersion = identifier(message.claude_code_version);
    } else if (type === "result") {
      metadata.subtype = identifier(message.subtype);
      metadata.isError = message.is_error === true;
    } else {
      return;
    }
    this.event(event, { ...fields, ...metadata });
  }

  line(event: string, line: string, fields: Fields = {}): void {
    // Skip streamed content before parsing; only the selected protocol frames are useful.
    if (
      !/"type"\s*:\s*"(?:control_request|control_response|control_cancel_request|command_lifecycle|user|system|result)"/u.test(
        line,
      )
    )
      return;
    try {
      this.message(event, JSON.parse(line), fields);
    } catch {
      // A malformed native frame remains the SDK's responsibility.
    }
  }

  observeWrites(stdin: Writable, pid: number | undefined): void {
    const observeLine = this.line.bind(this);
    const originalWrite = stdin.write;
    // SDK ProcessTransport and our custom control sender write one complete JSON line.
    // Observe that call without wrapping callbacks or changing backpressure/return values.
    stdin.write = function (this: Writable, ...args: unknown[]): boolean {
      const ready = Reflect.apply(originalWrite, this, args) as boolean;
      try {
        const chunk = args[0];
        const line =
          typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
        observeLine("stdin.write", line, {
          pid,
          writable: this.writable,
          ended: this.writableEnded,
          destroyed: this.destroyed,
          bufferedBytes: this.writableLength,
          backpressure: !ready,
        });
      } catch {
        // Inspecting a chunk must not affect a successful write.
      }
      return ready;
    } as Writable["write"];
  }
}
