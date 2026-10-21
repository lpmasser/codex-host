import { describe, expect, it } from "vitest";
import { createHarnessAdapter } from "../src/plugin.js";

describe("WorkBuddy CN plugin entry", () => {
  it("creates the China release under its own Harness ID", async () => {
    const local = createHarnessAdapter({
      environment: { CODEXHOST_WORKBUDDY_COMMAND: "/international/only" },
      platform: "darwin",
      managedRemoteHost: false,
      launchCommand: "/china/selected",
    });
    const brokered = createHarnessAdapter({
      environment: {},
      platform: "darwin",
      managedRemoteHost: true,
      brokerDescriptorPath: "/unused/workbuddy-cn-broker-v1.json",
    });
    try {
      expect(local.constructor.name).toBe("WorkBuddyAdapter");
      expect(local.harnessId).toBe("workbuddy-cn");
      // The saved launch path becomes this release's override; the international one is inert.
      expect(await local.inspect({ cwd: process.cwd() })).toMatchObject({
        status: "notInstalled",
        error: { message: expect.stringContaining("WorkBuddy CN app or its bundled CLI") },
      });
      expect(brokered.constructor.name).toBe("BrokeredHarnessAdapter");
      expect(brokered.harnessId).toBe("workbuddy-cn");
    } finally {
      await local.close();
      await brokered.close();
    }
  });
});
