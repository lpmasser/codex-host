import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { ClaudeSubagentLifecycle } from "../src/subagent-lifecycle.js";

describe("Native background Agent ownership", () => {
  it("settles every delegation to the same native task, including SendMessage", () => {
    const events: HostEvent[] = [];
    let ordinal = 0;
    const agents = new ClaudeSubagentLifecycle({
      newItemId: () => hostItemIdSchema.parse(`item-${++ordinal}`),
      emit: (event) => events.push(event),
    });
    for (const operation of ["spawn", "send"] as const) {
      const turnId = hostTurnIdSchema.parse(operation);
      agents.start(turnId, {
        type: "subagent.started",
        callId: operation,
        operation,
        description: "same task",
        background: true,
        nativeSubagentId: "native-task",
      });
      agents.complete(
        {
          type: "subagent.completed",
          callId: operation,
          isError: false,
          continuesInBackground: true,
        },
        false,
      );
      agents.finalize(turnId, { status: "succeeded" });
      expect(agents.owner(operation)?.turnId).toBe(turnId);
    }
    expect(
      agents.settle({
        type: "subagent.settled",
        nativeSubagentId: "native-task",
        callId: "spawn",
        status: "completed",
      }),
    ).toBe(true);
    expect(events.filter((event) => event.type === "item.completed")).toMatchObject([
      { turnId: "spawn", snapshot: { outcome: { status: "succeeded" } } },
      { turnId: "send", snapshot: { outcome: { status: "succeeded" } } },
    ]);
    expect(agents.taskIds()).toEqual([]);
    expect(agents.owner("send")).toBeUndefined();
  });
});
