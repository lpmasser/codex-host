import { afterEach, expect, it, vi } from "vitest";
import { installRendererMotionReentry } from "../src/renderer-motion-reentry.js";

const native = vi.hoisted(() => ({ getter: null as unknown }));
vi.mock("../src/codex-native-services.js", () => ({
  loadCodexNativeServices: async (_window: Window, matches: (value: unknown) => boolean) =>
    matches(native.getter) ? native.getter : null,
}));
afterEach(() => vi.restoreAllMocks());

it("uses native animation for completed-exit reentry and restores the original feature on dispose", async () => {
  const observed: boolean[] = [];
  class Exit {
    isExitComplete = true;
    node = {
      blockInitialAnimation: true,
      presenceContext: { isPresent: true },
      prevPresenceContext: { isPresent: false },
    };
    update() {
      observed.push(this.node.blockInitialAnimation);
    }
    mount() {}
  }
  class Animation {
    updateAnimationControlsSubscription() {}
  }
  const features = { animation: { Feature: Animation }, exit: { Feature: Exit } };
  native.getter = new Function("features", "return function(){return features}")(features);
  const original = Exit.prototype.update;
  const installation = installRendererMotionReentry({} as Window);
  await installation.ready;
  try {
    const exit = new Exit();
    exit.update();
    expect(observed).toEqual([false]);
    expect(exit.node.blockInitialAnimation).toBe(true);
    exit.isExitComplete = false;
    exit.update();
    expect(observed).toEqual([false, true]);
    exit.isExitComplete = true;
    exit.node.prevPresenceContext.isPresent = true;
    exit.update();
    expect(observed).toEqual([false, true, true]);
  } finally {
    installation.dispose();
  }
  expect(Exit.prototype.update).toBe(original);
});
