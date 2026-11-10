import {
  DELEGATION_CHILDREN_MAX_PARENTS,
  hostThreadIdSchema,
  type DelegationChild,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import { createRendererAgentIcon, rendererAgentLabel } from "./renderer-agent-icon.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  SIDEBAR_AGENT_ICON_ATTRIBUTE,
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";

/**
 * Corner count on the Agent icon of a Thread that started other Threads with `delegate start`,
 * blue while any of them runs; the icon then opens a popover listing each child, running ones
 * first, with its status. The data is the Host's
 * Delegation records; the badge only reads, and opening a child uses Desktop's own router.
 */

const BADGE_ATTRIBUTE = "data-codexhost-delegation-badge";
const POPOVER_ATTRIBUTE = "data-codexhost-delegation-popover";
const LOCAL_HOST_ID = "local";
const POLL_INTERVAL_MS = 5_000;
const SIDEBAR_SCROLL_SELECTOR = "[data-app-action-sidebar-scroll]";

type ChildState = "running" | "failed" | "finished";

export function delegationChildState(child: Pick<DelegationChild, "status">): ChildState {
  if (child.status === "creating" || child.status === "running") return "running";
  return child.status === "failed" ? "failed" : "finished";
}

const STATE_LABEL: Record<ChildState, string> = {
  running: "运行中",
  failed: "报错",
  finished: "已结束",
};
const STATE_GLYPH: Record<ChildState, string> = { running: "●", failed: "✕", finished: "✓" };

export interface RendererSidebarDelegationBadges {
  dispose(): void;
}

export function installRendererSidebarDelegationBadges(options: {
  getClient(hostId: string): RendererModelClient | null;
  getPlugins?(hostId: string): readonly HarnessPluginDescriptor[] | undefined;
  openThread(threadId: string): Promise<void>;
  root?: Document;
}): RendererSidebarDelegationBadges {
  const root = options.root ?? document;
  const view = root.defaultView ?? window;
  let children = new Map<string, readonly DelegationChild[]>();
  let disposed = false;
  let polling = false;
  let applyScheduled = false;
  let popover: { element: HTMLElement; close(): void } | null = null;

  const localRows = (): { element: HTMLElement; threadId: string }[] => {
    const rows: { element: HTMLElement; threadId: string }[] = [];
    for (const element of root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)) {
      if (element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE) !== LOCAL_HOST_ID) continue;
      const threadId = threadIdFromSidebarRowElement(element);
      if (threadId) rows.push({ element, threadId });
    }
    return rows;
  };

  const plugin = (harnessId: string): HarnessPluginDescriptor | undefined =>
    harnessId === "codex"
      ? undefined
      : options.getPlugins?.(LOCAL_HOST_ID)?.find(({ id }) => id === harnessId);

  const closePopover = (): void => {
    popover?.close();
    popover = null;
  };

  const openPopover = async (anchor: HTMLElement, parentThreadId: string): Promise<void> => {
    closePopover();
    const client = options.getClient(LOCAL_HOST_ID);
    if (!client?.listDelegationChildren) return;
    const parent = hostThreadIdSchema.parse(parentThreadId);
    const result = await client.listDelegationChildren({
      threadIds: [parent],
      includeTitles: true,
    });
    // The Host lists newest first; running children move to the top, keeping that order.
    const list = (result.parents[0]?.children ?? []).toSorted(
      (left, right) =>
        Number(delegationChildState(right) === "running") -
        Number(delegationChildState(left) === "running"),
    );
    if (disposed || !anchor.isConnected) return;
    closePopover();

    const element = root.createElement("div");
    element.setAttribute(POPOVER_ATTRIBUTE, "");
    element.setAttribute("role", "menu");
    const rect = anchor.getBoundingClientRect();
    Object.assign(element.style, {
      position: "fixed",
      top: `${Math.round(rect.bottom + 4)}px`,
      left: `${Math.round(rect.left)}px`,
      zIndex: "2147483000",
      minWidth: "220px",
      maxWidth: "360px",
      maxHeight: "320px",
      overflowY: "auto",
      padding: "4px",
      borderRadius: "8px",
      border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
      background: "Canvas",
      color: "CanvasText",
      boxShadow: "0 8px 24px rgb(0 0 0 / 24%)",
      font: "12px/1.4 system-ui, -apple-system, sans-serif",
    } satisfies Partial<CSSStyleDeclaration>);

    for (const child of list) {
      const state = delegationChildState(child);
      const item = root.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      Object.assign(item.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        width: "100%",
        padding: "5px 6px",
        border: "0",
        borderRadius: "5px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      } satisfies Partial<CSSStyleDeclaration>);
      item.addEventListener("mouseenter", () => {
        item.style.background = "color-mix(in srgb, currentColor 8%, transparent)";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "transparent";
      });

      const icon = createRendererAgentIcon(child.harnessId, 14, root, plugin(child.harnessId));
      const title = root.createElement("span");
      title.textContent =
        child.title ?? rendererAgentLabel(child.harnessId, plugin(child.harnessId));
      Object.assign(title.style, {
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      } satisfies Partial<CSSStyleDeclaration>);
      const status = root.createElement("span");
      status.textContent = `${STATE_GLYPH[state]} ${STATE_LABEL[state]}`;
      Object.assign(status.style, {
        flex: "none",
        opacity: state === "finished" ? "0.6" : "1",
        color: state === "failed" ? "#e5484d" : "inherit",
      } satisfies Partial<CSSStyleDeclaration>);
      item.append(icon, title, status);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closePopover();
        void options.openThread(child.threadId).catch(() => undefined);
      });
      element.append(item);
    }

    const onPointerDown = (event: Event): void => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) closePopover();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closePopover();
    };
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("keydown", onKeyDown, true);
    root.body.append(element);
    popover = {
      element,
      close() {
        root.removeEventListener("pointerdown", onPointerDown, true);
        root.removeEventListener("keydown", onKeyDown, true);
        element.remove();
      },
    };
  };

  // The badge decorates the row's Agent icon, which `renderer-sidebar-agent-icons` owns and may
  // recreate; a recreated icon is decorated again on the next sidebar mutation.
  const decorations = new WeakMap<HTMLElement, () => void>();

  const undecorate = (icon: HTMLElement): void => {
    decorations.get(icon)?.();
    decorations.delete(icon);
  };

  const renderBadge = (row: HTMLElement, threadId: string): void => {
    const icon = row.querySelector<HTMLElement>(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`);
    if (!icon) return;
    const list = children.get(threadId) ?? [];
    if (list.length === 0) {
      undecorate(icon);
      return;
    }
    const running = list.some((child) => delegationChildState(child) === "running");
    const presentation = `${threadId}:${list.length}:${running}`;
    if (icon.getAttribute(BADGE_ATTRIBUTE) === presentation) return;
    undecorate(icon);

    const original = {
      title: icon.title,
      label: icon.getAttribute("aria-label"),
      role: icon.getAttribute("role"),
      style: icon.getAttribute("style"),
    };
    const label = `${original.label ?? ""} · 已派出 ${list.length} 个会话${running ? "，有会话运行中" : ""}`;
    icon.setAttribute(BADGE_ATTRIBUTE, presentation);
    icon.setAttribute("role", "button");
    icon.setAttribute("aria-label", label);
    icon.title = label;
    icon.tabIndex = 0;
    Object.assign(icon.style, {
      position: "relative",
      pointerEvents: "auto",
      cursor: "pointer",
    } satisfies Partial<CSSStyleDeclaration>);

    const count = root.createElement("span");
    count.textContent = list.length > 9 ? "9+" : String(list.length);
    Object.assign(count.style, {
      position: "absolute",
      right: "-6px",
      bottom: "-4px",
      minWidth: "11px",
      height: "11px",
      padding: "0 2px",
      boxSizing: "border-box",
      borderRadius: "6px",
      background: running ? "#3e9bff" : "color-mix(in srgb, currentColor 45%, transparent)",
      color: "#fff",
      font: "600 8px/11px system-ui, -apple-system, sans-serif",
      textAlign: "center",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    icon.append(count);

    const open = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      void openPopover(icon, threadId).catch(() => undefined);
    };
    const swallow = (event: Event): void => event.stopPropagation();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" || event.key === " ") open(event);
    };
    // The row navigates on press; keep the icon's own press from reaching it.
    const pressEvents = ["pointerdown", "mousedown", "pointerup", "mouseup"] as const;
    for (const type of pressEvents) icon.addEventListener(type, swallow);
    icon.addEventListener("click", open);
    icon.addEventListener("keydown", onKeyDown);
    decorations.set(icon, () => {
      for (const type of pressEvents) icon.removeEventListener(type, swallow);
      icon.removeEventListener("click", open);
      icon.removeEventListener("keydown", onKeyDown);
      count.remove();
      icon.removeAttribute(BADGE_ATTRIBUTE);
      icon.removeAttribute("tabindex");
      icon.title = original.title;
      for (const [name, value] of [
        ["aria-label", original.label],
        ["role", original.role],
        ["style", original.style],
      ] as const) {
        if (value === null) icon.removeAttribute(name);
        else icon.setAttribute(name, value);
      }
    });
  };

  const apply = (): void => {
    applyScheduled = false;
    if (disposed) return;
    for (const { element, threadId } of localRows()) renderBadge(element, threadId);
  };

  const scheduleApply = (): void => {
    if (disposed || applyScheduled) return;
    applyScheduled = true;
    view.requestAnimationFrame(apply);
  };

  const poll = async (): Promise<void> => {
    if (disposed || polling || root.visibilityState === "hidden") return;
    observeSidebar();
    const client = options.getClient(LOCAL_HOST_ID);
    if (!client?.listDelegationChildren) return;
    const threadIds = [
      ...new Set(localRows().map(({ threadId }) => hostThreadIdSchema.parse(threadId))),
    ];
    if (threadIds.length === 0) return;
    polling = true;
    try {
      const next = new Map<string, readonly DelegationChild[]>();
      for (let index = 0; index < threadIds.length; index += DELEGATION_CHILDREN_MAX_PARENTS) {
        const result = await client.listDelegationChildren({
          threadIds: threadIds.slice(index, index + DELEGATION_CHILDREN_MAX_PARENTS),
        });
        for (const parent of result.parents)
          if (parent.children.length > 0) next.set(parent.threadId, parent.children);
      }
      if (disposed) return;
      children = next;
      scheduleApply();
    } catch {
      // Older or unreachable Hosts: keep the last known badges and try on the next tick.
    } finally {
      polling = false;
    }
  };

  // Desktop re-renders and virtualizes rows; badges are restored from the last poll. Only the
  // sidebar is observed: transcript streaming must not trigger row scans.
  let observed: Element | null = null;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (target?.closest(`[${BADGE_ATTRIBUTE}], [${POPOVER_ATTRIBUTE}]`)) continue;
      scheduleApply();
      return;
    }
  });
  const observeSidebar = (): void => {
    const sidebar = root.querySelector(SIDEBAR_SCROLL_SELECTOR);
    if (sidebar === observed) return;
    observer.disconnect();
    observed = sidebar;
    if (sidebar) observer.observe(sidebar, { childList: true, subtree: true });
  };
  const timer = view.setInterval(() => void poll(), POLL_INTERVAL_MS);
  const onVisibility = (): void => void poll();
  root.addEventListener("visibilitychange", onVisibility);
  void poll();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      view.clearInterval(timer);
      root.removeEventListener("visibilitychange", onVisibility);
      closePopover();
      for (const icon of root.querySelectorAll<HTMLElement>(`[${BADGE_ATTRIBUTE}]`))
        undecorate(icon);
    },
  };
}
