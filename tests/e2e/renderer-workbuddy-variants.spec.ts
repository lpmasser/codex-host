import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountRendererAgentPicker, renderRendererAgentPicker } from "./packages/renderer-extension/src/renderer-agent-picker.ts";
      import { modelSelectionForAgent } from "./packages/renderer-extension/src/versioned-renderer-adapter.ts";
      import { decodeHarnessPluginRoute, harnessPluginDescriptorSchema } from "@codexhost/shared-contracts";
      import workBuddy from "./packages/adapters/workbuddy/manifest.json";
      import workBuddyCn from "./packages/adapters/workbuddy-cn/manifest.json";
      // The picker names Agents from the target Host's plugin directory, here the shipped Manifests.
      const plugins = [workBuddy, workBuddyCn].map((manifest) =>
        harnessPluginDescriptorSchema.strip().parse({ ...manifest, icon: undefined }),
      );
      const state = { agent: "codex", phase: "draft" };
      const availability = { workbuddy: "ready", "workbuddy-cn": "ready" };
      const control = mountRendererAgentPicker("workbuddy-variants", ["codex", "workbuddy", "workbuddy-cn"], (agent) => {
        state.agent = agent;
        const selection = modelSelectionForAgent(null, null, agent);
        globalThis.selectedHarness = decodeHarnessPluginRoute(selection.model).harnessId;
        render();
      }, (agent) => { globalThis.installAgent = agent; }, undefined, undefined, plugins);
      function render() { renderRendererAgentPicker(control, state, "ready", false, availability); }
      globalThis.setAvailability = (agent, status) => { availability[agent] = status; render(); };
      document.body.append(control.root);
      render();
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  loader: { ".svg": "dataurl", ".png": "dataurl" },
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("WorkBuddy picker test bundle was not generated");

test("WorkBuddy and WorkBuddy CN appear separately and select distinct Harness routes", async ({
  page,
}, testInfo) => {
  await page.setContent(
    '<!doctype html><body style="display:flex;align-items:flex-end;height:90vh"></body>',
  );
  await page.addScriptTag({ content: bundle });
  const trigger = page.locator('[data-codexhost-agent-control="workbuddy-variants"] > button');
  const global = page.getByRole("menuitemradio", { name: "WorkBuddy", exact: true });
  const cn = page.getByRole("menuitemradio", { name: "WorkBuddy CN", exact: true });
  await trigger.click();
  await expect(global).toBeEnabled();
  await expect(cn).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("workbuddy-variants.png") });
  await cn.click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "selectedHarness"))).toBe(
    "workbuddy-cn",
  );
  await expect(trigger).toHaveAttribute("aria-label", "Select Agent, current WorkBuddy CN");
  await trigger.click();
  await global.click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "selectedHarness"))).toBe("workbuddy");
  await page.evaluate(() =>
    Reflect.get(globalThis, "setAvailability")("workbuddy-cn", "notInstalled"),
  );
  await trigger.click();
  await expect(global).toBeEnabled();
  // A release that is not installed moves to the collapsed section; it is never routed elsewhere.
  await page.getByRole("button", { name: "More agents (1)", exact: true }).click();
  await expect(cn).toBeDisabled();
  await page.getByRole("button", { name: "Install WorkBuddy CN", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "installAgent"))).toBe("workbuddy-cn");
});
