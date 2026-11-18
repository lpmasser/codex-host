// @vitest-environment jsdom
import {
  harnessIdSchema,
  hostThreadIdSchema,
  type DelegationChild,
  type DelegationChildrenParams,
  type DelegationChildrenResult,
} from "@codexhost/shared-contracts";
import { afterEach, expect, it } from "vitest";

import type { RendererModelClient } from "../src/renderer-model-client.js";
import { installRendererSidebarDelegationBadges } from "../src/renderer-sidebar-delegation-badges.js";

const POPOVER = "[data-codexhost-delegation-popover]";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function child(id: string, status: DelegationChild["status"]): DelegationChild {
  return {
    threadId: hostThreadIdSchema.parse(id),
    harnessId: harnessIdSchema.parse("pi"),
    status,
    title: `${id} title`,
  };
}

/** A local sidebar row as Desktop renders it, with the Agent icon codexhost already decorates. */
function sidebarRow(sidebar: HTMLElement, threadId: string): HTMLElement {
  const row = document.createElement("div");
  const attributes = {
    "data-app-action-sidebar-thread-row": threadId,
    "data-app-action-sidebar-thread-id": threadId,
    "data-app-action-sidebar-thread-host-id": "local",
  };
  for (const [name, value] of Object.entries(attributes)) row.setAttribute(name, value);
  Object.defineProperty(row, "__reactFiber$test", {
    value: { memoizedProps: { conversationId: threadId, dataAttributes: attributes } },
  });
  const icon = document.createElement("span");
  icon.setAttribute("data-codexhost-sidebar-agent-icon", "pi");
  row.append(icon);
  sidebar.append(row);
  return icon;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const settle = () => new Promise((done) => setTimeout(done, 30));

function install(state: Map<string, DelegationChild[]>) {
  const opens: {
    params: DelegationChildrenParams;
    reply: ReturnType<typeof deferred<DelegationChildrenResult>>;
  }[] = [];
  const answer = (params: DelegationChildrenParams): DelegationChildrenResult => ({
    parents: params.threadIds.map((threadId) => ({
      threadId,
      children: state.get(threadId) ?? [],
    })),
  });
  const client = {
    async listDelegationChildren(params: DelegationChildrenParams) {
      if (!params.includeTitles) return answer(params);
      const reply = deferred<DelegationChildrenResult>();
      opens.push({ params, reply });
      return reply.promise;
    },
  } as unknown as RendererModelClient;
  const sidebar = document.createElement("aside");
  sidebar.setAttribute("data-app-action-sidebar-scroll", "");
  document.body.append(sidebar);
  const icons = { a: sidebarRow(sidebar, "parent-a"), b: sidebarRow(sidebar, "parent-b") };
  const badges = installRendererSidebarDelegationBadges({
    getClient: () => client,
    openThread: async () => undefined,
  });
  disposers.push(() => badges.dispose());
  /** Answers the open request the user made `index`-th, with the state at that moment. */
  const respond = (index: number): void => {
    const open = opens[index];
    if (!open) throw new Error(`no open request ${index}`);
    open.reply.resolve(answer(open.params));
  };
  return { icons, respond };
}

const popoverText = () => document.querySelector(POPOVER)?.textContent;

it("keeps the list the user opened last when an earlier request answers late", async () => {
  const state = new Map([
    ["parent-a", [child("child-a", "running")]],
    ["parent-b", [child("child-b", "running")]],
  ]);
  const { icons, respond } = install(state);
  await settle();

  icons.a.click();
  icons.b.click();
  respond(1);
  await settle();
  respond(0);
  await settle();

  expect(document.querySelectorAll(POPOVER)).toHaveLength(1);
  expect(popoverText()).toContain("child-b title");
});

it("updates an open list with the same poll that updates its badge", async () => {
  const state = new Map([["parent-b", [child("child-b", "running")]]]);
  const { icons, respond } = install(state);
  await settle();

  icons.b.click();
  respond(0);
  await settle();
  expect(popoverText()).toContain("运行中");
  const focusChild = () =>
    document.querySelector<HTMLElement>('[data-codexhost-delegation-child="child-b"]')?.focus();
  const focusedChild = () =>
    document.activeElement?.getAttribute("data-codexhost-delegation-child") ?? null;

  focusChild();
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();
  expect(focusedChild()).toBe("child-b");

  state.set("parent-b", [child("child-b", "question")]);
  document.dispatchEvent(new Event("visibilitychange"));
  await settle();

  expect(icons.b.getAttribute("data-codexhost-delegation-badge")).toBe("parent-b:1:question");
  expect(popoverText()).toContain("待回答");
  expect(focusedChild()).toBe("child-b");
});
