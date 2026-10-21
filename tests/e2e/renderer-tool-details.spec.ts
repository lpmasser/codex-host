import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
test.use({ locale: "en-US" });

// The page mirrors the structure read from Desktop 26.928.21956: a transcript
// unit publishes the Item ids of its whole activity group, rows carry no id in
// the DOM, and each row component receives `conversationId` and the UI item
// (`callId`, no output). Details must therefore come from conversation state,
// which Desktop replaces immutably and announces through conversation callbacks.
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createRendererHostClients } from "./packages/renderer-extension/src/renderer-host-clients.ts";

      const call = (id, tool, args, status, output) => ({
        id, type: "dynamicToolCall", namespace: null, tool, arguments: args, status,
        contentItems: output === null ? null : [{ type: "inputText", text: output }],
        success: status === "inProgress" ? null : status === "completed",
        durationMs: null,
      });
      const turn = (turnId, items) => ({ turnId, status: "completed", items });
      const createManager = (conversations) => {
        const callbacks = new Map();
        return {
          conversations,
          callbacks,
          reads: 0,
          sendRequest: async () => ({}),
          getConversation(threadId) {
            this.reads += 1;
            return conversations.get(threadId) ?? null;
          },
          addConversationCallback(threadId, callback) {
            const registered = callbacks.get(threadId) ?? new Set();
            callbacks.set(threadId, registered.add(callback));
            return () => registered.delete(callback);
          },
        };
      };
      const managers = {
        local: createManager(new Map([
          ["live", { id: "live", modelProvider: "codexhost", turns: [turn("t1", [
            call("call-1", "view_file", { AbsolutePath: "/a.txt", Note: "<b>raw</b>" }, "completed", "alpha"),
            call("call-2", "view_file", { AbsolutePath: "/b.txt" }, "completed", "beta"),
            call("call-3", "replace_file_content", { TargetFile: "/c.txt" }, "failed", "target content not found"),
            call("call-4", "list_dir", { DirectoryPath: "/src" }, "inProgress", null),
            { ...call("call-5", "screenshot", {}, "completed", null), contentItems: [
              { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
            ] },
          ])] }],
          ["history", { id: "history", modelProvider: "codexhost", turns: [], turnHistory: { kind: "canonical", history: {
            islands: [{ entries: [{ value: "turn:h1" }] }],
            entitiesByKey: { "turn:h1": turn("h1", [
              call("old-1", "view_file", { AbsolutePath: "/old-a.txt" }, "completed", "old alpha"),
              call("old-2", "view_file", { AbsolutePath: "/old-b.txt" }, "failed", "old failure"),
            ]) },
          } } }],
          ["native", { id: "native", modelProvider: "openai", turns: [turn("n1", [
            call("native-1", "view_file", { AbsolutePath: "/native.txt" }, "completed", "native"),
          ])] }],
        ])),
        remote: createManager(new Map([
          ["far", { id: "far", modelProvider: "codexhost", turns: [turn("r1", [
            call("far-1", "view_file", { AbsolutePath: "/far.txt" }, "inProgress", null),
          ])] }],
        ])),
      };
      const routes = new Map(Object.entries(managers).map(([hostId, manager]) => [
        hostId,
        { hostId, manager, policy: {} },
      ]));
      const clients = createRendererHostClients(
        () => ({ forHost: (hostId) => routes.get(hostId) ?? null }),
        window,
        document,
      );
      for (const hostId of routes.keys()) {
        if (!clients.forHost(hostId)) throw new Error("Host client was not created");
      }
      const managerOf = (threadId) =>
        Object.values(managers).find((manager) => manager.conversations.has(threadId));

      const fiberOf = (element, props, parent) => {
        const fiber = { stateNode: element, memoizedProps: props, return: parent };
        if (element) Object.defineProperty(element, "__reactFiber$fixture", { value: fiber });
        return fiber;
      };
      const turnsOf = (conversation) => conversation.turnHistory
        ? Object.values(conversation.turnHistory.history.entitiesByKey)
        : conversation.turns;
      const uiItem = (item) => ({
        type: "dynamic-tool-call", callId: item.id, namespace: item.namespace, tool: item.tool,
        arguments: item.arguments, completed: item.status !== "inProgress",
      });
      globalThis.nativeClicks = 0;
      const appendRow = (unit, threadId, item) => {
        const wrapper = document.createElement("div");
        const wrapperFiber = fiberOf(wrapper, {}, unit["__reactFiber$fixture"]);
        const view = {
          stateNode: null,
          memoizedProps: { conversationId: threadId, hostId: "local", item: uiItem(item) },
          return: wrapperFiber,
        };
        const rowComponent = {
          stateNode: null,
          memoizedProps: { conversationId: threadId, item: uiItem(item) },
          return: view,
        };
        const fallback = {
          stateNode: null,
          memoizedProps: { item: uiItem(item), variant: "row" },
          return: rowComponent,
        };
        const row = document.createElement("div");
        row.dataset.testid = "row-" + item.id;
        const rowFiber = fiberOf(row, {}, fallback);
        const label = document.createElement("span");
        label.textContent = item.tool;
        fiberOf(label, {}, rowFiber);
        row.append(label);
        if (item.id === "call-2") {
          // A control Desktop owns inside the row.
          const child = document.createElement("button");
          child.dataset.testid = "native-child";
          child.textContent = "open";
          child.addEventListener("click", () => { globalThis.nativeClicks += 1; });
          fiberOf(child, {}, rowFiber);
          row.append(child);
        }
        if (item.id === "call-3") {
          row.style.cursor = "help";
          row.setAttribute("tabindex", "-1");
        }
        wrapper.append(row);
        unit.append(wrapper);
      };
      globalThis.renderThread = (threadId) => {
        document.querySelector('[data-thread="' + threadId + '"]')?.remove();
        const items = turnsOf(managerOf(threadId).conversations.get(threadId))
          .flatMap((entry) => entry.items);
        const unit = document.createElement("div");
        unit.dataset.thread = threadId;
        unit.setAttribute(
          "data-local-conversation-item-target-ids",
          items.map((item) => encodeURIComponent(item.id)).join(" "),
        );
        const unitFiber = fiberOf(unit, {}, null);
        const header = document.createElement("button");
        header.dataset.testid = "header-" + threadId;
        header.textContent = "Worked";
        fiberOf(header, {}, {
          stateNode: null,
          memoizedProps: { item: uiItem(items[0]), variant: "summary-text" },
          return: unitFiber,
        });
        unit.append(header);
        for (const item of items) appendRow(unit, threadId, item);
        document.body.append(unit);
      };
      // Desktop renders the rows of a group only once it is expanded.
      globalThis.appendLateRow = (threadId) => {
        const item = call("late-1", "view_file", { AbsolutePath: "/late.txt" }, "completed", "late");
        const { conversations } = managerOf(threadId);
        const conversation = conversations.get(threadId);
        conversations.set(threadId, { ...conversation, turns: [...conversation.turns, turn("t2", [item])] });
        appendRow(document.querySelector('[data-thread="' + threadId + '"]'), threadId, item);
      };
      // Desktop replaces the Item immutably and notifies; the row's DOM is untouched.
      globalThis.settle = (threadId, itemId, status, output) => {
        const manager = managerOf(threadId);
        const conversation = manager.conversations.get(threadId);
        const next = { ...conversation, turns: conversation.turns.map((entry) => ({
          ...entry,
          items: entry.items.map((item) => item.id === itemId
            ? call(item.id, item.tool, item.arguments, status, output)
            : item),
        })) };
        manager.conversations.set(threadId, next);
        for (const callback of [...(manager.callbacks.get(threadId) ?? [])]) callback(next);
      };
      globalThis.subscriptions = (hostId, threadId) => managers[hostId].callbacks.get(threadId)?.size ?? 0;
      globalThis.reads = (hostId) => managers[hostId].reads;
      // A disconnected Host loses its route; the next lookup retires its binding.
      globalThis.retireHost = (hostId) => {
        routes.delete(hostId);
        clients.forHost(hostId);
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "renderer-tool-details-e2e.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Missing tool detail fixture bundle");

function fixture<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([name, args]) =>
      (Reflect.get(globalThis, name as string) as (...args: unknown[]) => T)(
        ...(args as unknown[]),
      ),
    [name, args],
  );
}

async function open(page: Page, ...threadIds: string[]): Promise<void> {
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundle });
  for (const threadId of threadIds) await fixture(page, "renderThread", threadId);
}

const panels = (page: Page) => page.locator("[data-codexhost-tool-detail-panel]");
const panel = (page: Page, itemId: string) =>
  page.locator(`[data-codexhost-tool-detail-panel="${itemId}"]`);

test("two calls to the same tool expand their own parameters and output", async ({ page }) => {
  await open(page, "live");
  const first = page.getByTestId("row-call-1");
  const second = page.getByTestId("row-call-2");

  await first.hover();
  await expect(first).toHaveAttribute("data-codexhost-tool-detail-row", "call-1");
  await expect(first).toHaveAttribute("role", "button");
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(first).toHaveCSS("cursor", "pointer");

  await first.click();
  await second.getByText("view_file").click();
  await expect(panels(page)).toHaveCount(2);
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(second).toHaveAttribute("aria-expanded", "true");

  await expect(panel(page, "call-1").locator('[data-part="tool"]')).toHaveText("view_file");
  await expect(panel(page, "call-1").locator('[data-part="status"]')).toHaveText("Completed");
  await expect(panel(page, "call-1").locator('[data-part="parameters"]')).toContainText(
    '"AbsolutePath": "/a.txt"',
  );
  // Parameters are text, never markup.
  await expect(panel(page, "call-1").locator('[data-part="parameters"]')).toContainText(
    "<b>raw</b>",
  );
  await expect(panel(page, "call-1").locator('[data-part="output"]')).toHaveText("alpha");
  await expect(panel(page, "call-1")).not.toContainText("/b.txt");

  await expect(panel(page, "call-2").locator('[data-part="parameters"]')).toContainText(
    '"AbsolutePath": "/b.txt"',
  );
  await expect(panel(page, "call-2").locator('[data-part="output"]')).toHaveText("beta");
  await expect(panel(page, "call-2")).not.toContainText("/a.txt");

  // Each panel follows its own row.
  expect(
    await page.evaluate(() =>
      ["call-1", "call-2"].map((id) =>
        document
          .querySelector(`[data-testid="row-${id}"]`)
          ?.nextElementSibling?.getAttribute("data-codexhost-tool-detail-panel"),
      ),
    ),
  ).toEqual(["call-1", "call-2"]);

  await first.click();
  await expect(panel(page, "call-1")).toHaveCount(0);
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(panel(page, "call-2")).toBeVisible();
});

test("a failed call shows its failed status, and image output is shown", async ({ page }) => {
  await open(page, "live");
  await page.getByTestId("row-call-3").click();
  const failed = panel(page, "call-3");
  await expect(failed).toHaveAttribute("data-status", "failed");
  await expect(failed.locator('[data-part="tool"]')).toHaveText("replace_file_content");
  await expect(failed.locator('[data-part="status"]')).toHaveText("Failed");
  await expect(failed.locator('[data-part="parameters"]')).toContainText('"TargetFile": "/c.txt"');
  await expect(failed.locator('[data-part="output"]')).toHaveText("target content not found");

  await page.getByTestId("row-call-5").click();
  const image = panel(page, "call-5").locator('img[data-part="output"]');
  await expect(image).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
  await expect(image).toHaveAttribute("alt", "Output");
});

test("an open panel follows a running call through conversation state alone", async ({ page }) => {
  await open(page, "live");
  const row = page.getByTestId("row-call-4");
  const running = panel(page, "call-4");

  // A settled call needs no subscription; a closed panel keeps none.
  await page.getByTestId("row-call-1").click();
  expect(await fixture(page, "subscriptions", "local", "live")).toBe(0);
  await row.click();
  expect(await fixture(page, "subscriptions", "local", "live")).toBe(1);
  await row.click();
  expect(await fixture(page, "subscriptions", "local", "live")).toBe(0);

  await row.click();
  await expect(running.locator('[data-part="status"]')).toHaveText("Running");
  await expect(running.locator('[data-part="parameters"]')).toContainText(
    '"DirectoryPath": "/src"',
  );
  await expect(running.locator('[data-part="output"]')).toHaveCount(0);

  const before = await row.evaluate((element) => element.outerHTML);
  await fixture(page, "settle", "live", "call-4", "completed", "index.ts");
  expect(await row.evaluate((element) => element.outerHTML)).toBe(before);
  await expect(running.locator('[data-part="status"]')).toHaveText("Completed");
  await expect(running.locator('[data-part="output"]')).toHaveText("index.ts");
  // The final status ends the subscription.
  expect(await fixture(page, "subscriptions", "local", "live")).toBe(0);
});

test("restored history shows the same per-call details after a re-render", async ({ page }) => {
  await open(page, "history");
  for (let render = 0; render < 2; render += 1) {
    await page.getByTestId("row-old-1").click();
    await page.getByTestId("row-old-2").click();
    await expect(panel(page, "old-1").locator('[data-part="parameters"]')).toContainText(
      "/old-a.txt",
    );
    await expect(panel(page, "old-1").locator('[data-part="output"]')).toHaveText("old alpha");
    await expect(panel(page, "old-1").locator('[data-part="status"]')).toHaveText("Completed");
    await expect(panel(page, "old-2").locator('[data-part="parameters"]')).toContainText(
      "/old-b.txt",
    );
    await expect(panel(page, "old-2").locator('[data-part="output"]')).toHaveText("old failure");
    await expect(panel(page, "old-2").locator('[data-part="status"]')).toHaveText("Failed");
    // Reopening the Thread rebuilds its rows from history.
    await fixture(page, "renderThread", "history");
    await expect(panels(page)).toHaveCount(0);
  }
});

test("rows are keyboard disclosures and native child controls keep their input", async ({
  page,
}) => {
  await open(page, "live");
  const first = page.getByTestId("row-call-1");
  const second = page.getByTestId("row-call-2");

  // Focus entering the unit makes its rows reachable without any pointer.
  await page.getByTestId("header-live").focus();
  await expect(first).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page, "call-1").locator('[data-part="output"]')).toHaveText("alpha");
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(panel(page, "call-1")).toHaveCount(0);
  await expect(first).toHaveAttribute("aria-expanded", "false");

  // Rows rendered while focus stays in the unit become reachable too.
  await fixture(page, "appendLateRow", "live");
  await expect(page.getByTestId("row-late-1")).toHaveAttribute("role", "button");

  const child = page.getByTestId("native-child");
  await child.click();
  await expect(panels(page)).toHaveCount(0);
  await child.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => Reflect.get(globalThis, "nativeClicks") as number)).toBe(2);
  await expect(panels(page)).toHaveCount(0);
  await expect(second).toHaveAttribute("aria-expanded", "false");

  await second.getByText("view_file").click();
  await expect(panel(page, "call-2").locator('[data-part="output"]')).toHaveText("beta");
});

test("each Host binding releases only its own rows, panels and subscriptions", async ({ page }) => {
  await open(page, "live", "far");
  const near = page.getByTestId("row-call-1");
  const restored = page.getByTestId("row-call-3");
  const far = page.getByTestId("row-far-1");
  await near.click();
  await restored.hover();
  await far.click();
  await expect(panel(page, "far-1").locator('[data-part="status"]')).toHaveText("Running");
  await expect(restored).toHaveAttribute("tabindex", "0");
  expect(await fixture(page, "subscriptions", "remote", "far")).toBe(1);

  await fixture(page, "retireHost", "remote");
  await expect(panel(page, "far-1")).toHaveCount(0);
  await expect(far).not.toHaveAttribute("data-codexhost-tool-detail-row");
  await expect(far).not.toHaveAttribute("role");
  expect(await fixture(page, "subscriptions", "remote", "far")).toBe(0);
  // The other Host's panel and rows are untouched and still work.
  await expect(panel(page, "call-1")).toBeVisible();
  await expect(near).toHaveAttribute("aria-expanded", "true");

  // A released binding no longer reads its manager.
  const reads = await fixture<number>(page, "reads", "remote");
  await fixture(page, "settle", "far", "far-1", "completed", "done");
  await far.hover();
  await far.click();
  await expect(panels(page)).toHaveCount(1);
  expect(await fixture(page, "reads", "remote")).toBe(reads);

  await fixture(page, "retireHost", "local");
  await expect(panels(page)).toHaveCount(0);
  await expect(near).not.toHaveAttribute("role");
  // Attributes and cursor the row already had come back.
  await expect(restored).toHaveAttribute("tabindex", "-1");
  await expect(restored).toHaveCSS("cursor", "help");
  await near.click();
  await expect(panels(page)).toHaveCount(0);
});

test("native Threads and group headers are left alone", async ({ page }) => {
  await open(page, "live", "native");
  const native = page.getByTestId("row-native-1");
  await native.hover();
  await native.click();
  await page.getByTestId("header-native").focus();
  await page.getByTestId("header-live").click();
  await expect(panels(page)).toHaveCount(0);
  await expect(native).not.toHaveAttribute("data-codexhost-tool-detail-row");
  await expect(native).not.toHaveAttribute("role");
  await expect(native).not.toHaveCSS("cursor", "pointer");
});
