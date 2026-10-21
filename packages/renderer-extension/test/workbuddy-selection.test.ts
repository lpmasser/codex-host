import { describe, expect, it } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";

import { DraftAgentController } from "../src/agent-selection-state.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { rendererAgentLabel } from "../src/renderer-agent-icon.js";
import { pluginDescriptor } from "../../../tests/fixtures/harness-plugin-descriptors.js";
import { rendererAgentForThreadOwnership } from "../src/renderer-sidebar-agent-icons.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";

describe("WorkBuddy release identities in Desktop", () => {
  const model = harnessModelRefSchema.parse({ id: "cb.YXV0bw" });
  const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
  const permissionModeId = harnessPermissionModeIdSchema.parse("default");

  it.each([
    ["workbuddy", "workbuddy-cn"],
    ["workbuddy-cn", "workbuddy"],
    ["workbuddy", "codebuddy"],
    ["workbuddy-cn", "codebuddy"],
  ] as const)("routes %s only to its own Harness, excluding %s", (agent, other) => {
    const selection = modelSelectionForAgent(
      null,
      null,
      agent,
      model,
      thinkingOptionId,
      permissionModeId,
    );
    if (typeof selection?.model !== "string") throw new Error("No WorkBuddy carrier");
    expect(decodeHarnessPluginRoute(selection.model)).toEqual({
      harnessId: agent,
      model,
      thinkingOptionId,
      permissionModeId,
    });
    const inspection = {
      owner: "external" as const,
      transportModelId: selection.model,
      locked: true as const,
      history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
    };
    expect(restoredThreadOwnership({ ...inspection, harnessId: agent })).toEqual({
      agent,
      model,
      thinkingOptionId,
      permissionModeId,
    });
    expect(() => restoredThreadOwnership({ ...inspection, harnessId: other })).toThrow(
      "identity mismatch",
    );
    expect(
      rendererAgentForThreadOwnership({
        threadId: hostThreadIdSchema.parse(`${agent}-thread`),
        owner: "external",
        harnessId: harnessIdSchema.parse(agent),
      }),
    ).toBe(agent);
  });

  it("keeps Model, Thinking and Permission Mode separate for the two releases", async () => {
    const controller = new DraftAgentController({
      enabledAgents: ["codex", "codebuddy", "workbuddy", "workbuddy-cn"],
    });
    const composer = {};
    controller.mount(composer, ["default"]);
    const codeBuddyModel = harnessModelRefSchema.parse({ id: "cb.Y29kZWJ1ZGR5" });
    controller.setExternalModel(composer, "codebuddy", codeBuddyModel);
    const globalModel = harnessModelRefSchema.parse({ id: "cb.Z2xvYmFs" });
    const globalThinking = harnessThinkingOptionIdSchema.parse("low");
    const globalPermission = harnessPermissionModeIdSchema.parse("plan");
    controller.setExternalModel(composer, "workbuddy", globalModel);
    controller.setExternalThinkingOption(composer, "workbuddy", globalThinking);
    controller.setExternalPermissionMode(composer, "workbuddy", globalPermission);
    controller.setExternalModel(composer, "workbuddy-cn", model);
    controller.setExternalThinkingOption(composer, "workbuddy-cn", thinkingOptionId);
    controller.setExternalPermissionMode(composer, "workbuddy-cn", permissionModeId);
    const operations = { applyAgent: () => true, clearPrewarm: async () => undefined };
    for (const agent of ["workbuddy-cn", "workbuddy", "workbuddy-cn"] as const) {
      await controller.switchAgent(composer, agent, operations);
      expect(controller.get(composer).agent).toBe(agent);
    }
    expect(controller.modelForAgent(composer, "workbuddy")).toEqual(globalModel);
    expect(controller.thinkingOptionForAgent(composer, "workbuddy")).toBe(globalThinking);
    expect(controller.permissionModeForAgent(composer, "workbuddy")).toBe(globalPermission);
    expect(controller.modelForAgent(composer, "workbuddy-cn")).toEqual(model);
    expect(controller.thinkingOptionForAgent(composer, "workbuddy-cn")).toBe(thinkingOptionId);
    expect(controller.permissionModeForAgent(composer, "workbuddy-cn")).toBe(permissionModeId);
    expect(controller.modelForAgent(composer, "codebuddy")).toEqual(codeBuddyModel);
    controller.restore(composer, "workbuddy-cn");
    expect(controller.modelForAgent(composer, "workbuddy-cn")).toBeUndefined();
    expect(controller.thinkingOptionForAgent(composer, "workbuddy-cn")).toBeUndefined();
    expect(controller.modelForAgent(composer, "workbuddy")).toEqual(globalModel);
  });

  it.each([
    ["workbuddy", "WorkBuddy", "https://www.workbuddy.ai"],
    ["workbuddy-cn", "WorkBuddy CN", "https://www.workbuddy.cn"],
  ])("shows %s's name and installation guide", (agent, name, website) => {
    expect(rendererAgentLabel(agent, pluginDescriptor(agent))).toBe(name);
    expect(pluginDescriptor(agent).links?.installation).toBe(
      `${website}/docs/workbuddy/Quickstart`,
    );
  });
});
