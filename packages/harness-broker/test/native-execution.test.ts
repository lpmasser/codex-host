import { describe, expect, it } from "vitest";
import { harnessOutputSchema } from "../src/validation.js";

describe("Broker native input consumption", () => {
  const event = {
    type: "input.consumed",
    consumingTurnId: "consuming-turn",
    inputId: "input-id",
    input: [{ type: "text", text: "follow up" }],
    clientUserMessageId: "desktop-input",
  };
  it("preserves the input identity, consuming Turn and Desktop correlation", () => {
    const output = { kind: "event", event };
    expect(harnessOutputSchema.parse(output)).toEqual(output);
  });
  it.each([
    { consumingTurnId: "" },
    { inputId: undefined },
    { inputId: 42 },
    { input: [] },
    { input: [{ type: "image", text: "invalid" }] },
    { clientUserMessageId: 42 },
    { turnId: "unexpected-projection-field" },
  ])("rejects malformed consumption facts: %j", (invalid) => {
    expect(
      harnessOutputSchema.safeParse({ kind: "event", event: { ...event, ...invalid } }).success,
    ).toBe(false);
  });
});
