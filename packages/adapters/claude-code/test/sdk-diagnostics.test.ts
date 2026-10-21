import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClaudeSdkDiagnostics } from "../src/sdk-diagnostics.js";

describe("Claude SDK diagnostic boundary", () => {
  it("correlates control/input frames without copying any payloads or streamed content", () => {
    const lines: string[] = [];
    const log = new ClaudeSdkDiagnostics("native-session", (line) => lines.push(line));
    const sensitive = "PRIVATE prompt answer token reasoning error contents";
    const frames = [
      {
        type: "control_request",
        request_id: "control-1",
        request: {
          subtype: "get_context_usage",
          detail: "full",
          input: sensitive,
        },
      },
      { type: "user", uuid: "input-1", priority: "later", message: { content: sensitive } },
      {
        type: "control_response",
        response: {
          request_id: "control-1",
          subtype: "error",
          error: sensitive,
          response: { output: sensitive },
        },
      },
      { type: "command_lifecycle", command_uuid: "input-1", state: "queued", data: sensitive },
      { type: "stream_event", event: { type: "thinking_delta", thinking: sensitive } },
      { type: "assistant", message: { content: sensitive } },
      { type: "system", subtype: "other", text: sensitive },
      { type: "result", subtype: "success", result: sensitive },
    ];
    for (const frame of frames) log.line("stdout.message", JSON.stringify(frame));
    log.line("stdout.message", '{"type":"control_response",broken');
    expect(lines).toHaveLength(5);
    expect(lines.join("")).not.toContain(sensitive);
    const events = lines.map((line) => JSON.parse(line.slice("[claude-sdk] ".length)));
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(events.map((event) => event.transportId)).size).toBe(1);
    expect(events[0]).toMatchObject({
      requestId: "control-1",
      subtype: "get_context_usage",
      detail: "full",
    });
    expect(events[1]).toMatchObject({ messageId: "input-1", priority: "later" });
    expect(events[2]).toMatchObject({ requestId: "control-1", subtype: "error" });
    expect(events[3]).toMatchObject({ messageId: "input-1", state: "queued" });
  });

  it("preserves the write receiver, arguments, callback and backpressure", () => {
    const lines: string[] = [];
    const log = new ClaudeSdkDiagnostics("native-session", (line) => lines.push(line));
    const stdin = new Writable();
    const original = vi.spyOn(stdin, "write").mockImplementation(function (this: Writable) {
      expect(this).toBe(stdin);
      return false;
    });
    log.observeWrites(stdin, 123);
    const frame = Buffer.from('{"type":"user","uuid":"input-1","message":{"content":"SECRET"}}\n');
    const callback = vi.fn();
    expect(stdin.write(frame, "utf8", callback)).toBe(false);
    expect(original).toHaveBeenCalledExactlyOnceWith(frame, "utf8", callback);
    expect(callback).not.toHaveBeenCalled();
    expect(lines[0]).toContain('"event":"stdin.write"');
    expect(lines[0]).toContain('"backpressure":true');
    expect(lines[0]).not.toContain("SECRET");
  });

  it("does not let a failing diagnostic sink replace the original stream result or exception", () => {
    const log = new ClaudeSdkDiagnostics("native-session", () => {
      throw new Error("log unavailable");
    });
    const stdin = new Writable();
    const original = vi.spyOn(stdin, "write").mockReturnValue(true);
    log.observeWrites(stdin, 123);
    const frame =
      '{"type":"control_request","request_id":"c1","request":{"subtype":"interrupt"}}\n';
    expect(stdin.write(frame)).toBe(true);
    const failure = new Error("original write failure");
    original.mockImplementation(() => {
      throw failure;
    });
    expect(() => stdin.write(frame)).toThrow(failure);
    expect(original).toHaveBeenCalledTimes(2);
  });
});
