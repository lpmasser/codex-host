import { describe, expect, it } from "vitest";
import { harnessOutputSchema } from "../src/validation.js";

describe("Broker background interaction ownership", () => {
  it.each(["approval", "question"])(
    "retains a %s owner and rejects malformed Item identities",
    (type) => {
      const output = {
        kind: "interaction",
        interaction: {
          type,
          turnId: "old-turn",
          interactionId: "request",
          ownerItemId: "native-task-item",
        },
      };
      expect(harnessOutputSchema.parse(output)).toEqual(output);
      for (const ownerItemId of ["", {}, 42, null]) {
        expect(
          harnessOutputSchema.safeParse({
            ...output,
            interaction: { ...output.interaction, ownerItemId },
          }).success,
        ).toBe(false);
      }
    },
  );
});
