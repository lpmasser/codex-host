import { describe, expect, it } from "vitest";

import { findExternalToolCall, installRendererToolDetails } from "../src/renderer-tool-details.js";

function call(id: string, path: string, status = "completed") {
  return {
    id,
    type: "dynamicToolCall",
    namespace: null,
    tool: "view_file",
    arguments: { AbsolutePath: path },
    status,
    contentItems: [{ type: "inputText", text: `content of ${path}` }],
    success: status === "completed",
    durationMs: null,
  };
}

describe("external tool call lookup", () => {
  const first = call("call-1", "/a.txt");
  const second = call("call-2", "/b.txt", "failed");
  const legacy = {
    id: "thread",
    modelProvider: "codexhost",
    turns: [
      { turnId: "t1", items: [{ id: "message", type: "agentMessage" }, first] },
      { turnId: "t2", items: [second] },
    ],
  };

  it("finds same-name calls by their own Item id", () => {
    expect(findExternalToolCall(legacy, "thread", "call-1")).toBe(first);
    expect(findExternalToolCall(legacy, "thread", "call-2")).toBe(second);
    expect(findExternalToolCall(legacy, "thread", "message")).toBeNull();
    expect(findExternalToolCall(legacy, "thread", "missing")).toBeNull();
  });

  it("reads canonical history instead of the emptied legacy turns", () => {
    const canonical = {
      id: "thread",
      modelProvider: "codexhost",
      turns: [],
      turnHistory: {
        kind: "canonical",
        history: {
          islands: [{ entries: [{ value: "turn:t1" }] }],
          entitiesByKey: { "turn:t1": { turnId: "t1", items: [first, second] } },
        },
      },
    };
    expect(findExternalToolCall(canonical, "thread", "call-2")).toBe(second);
  });

  it("ignores native Codex Threads and mismatched conversations", () => {
    expect(
      findExternalToolCall({ ...legacy, modelProvider: "openai" }, "thread", "call-1"),
    ).toBeNull();
    expect(findExternalToolCall(legacy, "other", "call-1")).toBeNull();
    expect(findExternalToolCall(null, "thread", "call-1")).toBeNull();
  });
});

describe("tool detail installation", () => {
  it("does not bind without a transcript document or Desktop's conversation state API", () => {
    const manager = { getConversation: () => null, addConversationCallback: () => () => {} };
    expect(installRendererToolDetails(manager, null)).toBeNull();
    expect(installRendererToolDetails({}, {} as Document)).toBeNull();
    expect(
      installRendererToolDetails({ getConversation: manager.getConversation }, {} as Document),
    ).toBeNull();
  });
});
