import { rendererHarnessMessages } from "./renderer-harness-localization.js";
import { TRANSCRIPT_ITEM_SELECTOR } from "./renderer-transcript-dom.js";
import { resolveRendererSettingsLocale } from "./settings/localization.js";

export const TOOL_DETAIL_ROW_ATTRIBUTE = "data-codexhost-tool-detail-row";
export const TOOL_DETAIL_PANEL_ATTRIBUTE = "data-codexhost-tool-detail-panel";
const ROW_FIBER_DEPTH = 64;
// Clicks and keys on Desktop's own controls inside a row stay with Desktop.
const NATIVE_CONTROL_SELECTOR =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [contenteditable="true"]';
const ROW_MARK_ATTRIBUTES = [TOOL_DETAIL_ROW_ATTRIBUTE, "role", "tabindex", "aria-expanded"];

const PANEL_STYLE =
  "margin:4px 0 6px;padding:6px 8px;border:1px solid var(--color-token-border, rgba(127,127,127,.3));" +
  "border-radius:6px;font-size:12px;cursor:auto;user-select:text";
const LABEL_STYLE = "color:var(--color-text-tertiary, #8f8f8f)";
const MONO_STYLE = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace";
const TEXT_STYLE = `margin:2px 0 6px;max-height:10rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;${MONO_STYLE}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ToolDetailRow {
  readonly element: HTMLElement;
  readonly threadId: string;
  readonly itemId: string;
}

/**
 * Desktop 26.928 renders a `dynamicToolCall` without a registered renderer as
 * its tool name only, and the row's DOM carries no Item id: the transcript unit
 * publishes the ids of a whole activity group. The row component's own props
 * do identify the call (`item.callId`, `conversationId`), so two calls to the
 * same tool never share details. Both ids are fixed for the life of a row, so
 * the DOM node's possibly stale alternate Fiber still yields the right pair.
 */
export function toolDetailRowFromElement(origin: Element): ToolDetailRow | null {
  const unit = origin.closest(TRANSCRIPT_ITEM_SELECTOR);
  if (!unit) return null;
  const names = Object.getOwnPropertyNames(origin).filter((name) =>
    name.startsWith("__reactFiber$"),
  );
  const name = names[0];
  if (names.length !== 1 || !name) return null;
  let fiber: unknown = Object.getOwnPropertyDescriptor(origin, name)?.value;
  let element: HTMLElement | null = null;
  for (let depth = 0; isRecord(fiber) && depth < ROW_FIBER_DEPTH; depth += 1) {
    if (fiber.stateNode === unit) return null;
    if (fiber.stateNode instanceof HTMLElement) element = fiber.stateNode;
    const props = fiber.memoizedProps;
    // Group headers repeat the item as a `summary-text` part without a Thread.
    if (
      element &&
      isRecord(props) &&
      isRecord(props.item) &&
      props.item.type === "dynamic-tool-call" &&
      typeof props.item.callId === "string" &&
      typeof props.conversationId === "string"
    ) {
      return { element, threadId: props.conversationId, itemId: props.item.callId };
    }
    fiber = fiber.return;
  }
  return null;
}

/**
 * The `dynamicToolCall` Protocol Core projected for this Item, read from the
 * conversation Desktop renders. Only Host-projected external Threads qualify.
 * Desktop keeps Turns in its canonical history when present and in `turns`
 * otherwise; its own Turn lookups make the same choice.
 */
export function findExternalToolCall(
  conversation: unknown,
  threadId: string,
  itemId: string,
): Record<string, unknown> | null {
  if (
    !isRecord(conversation) ||
    conversation.id !== threadId ||
    conversation.modelProvider !== "codexhost"
  ) {
    return null;
  }
  const history =
    isRecord(conversation.turnHistory) && conversation.turnHistory.kind === "canonical"
      ? conversation.turnHistory.history
      : null;
  const turns: unknown =
    isRecord(history) && isRecord(history.entitiesByKey)
      ? Object.values(history.entitiesByKey)
      : conversation.turns;
  if (!Array.isArray(turns)) return null;
  for (const turn of turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      if (isRecord(item) && item.type === "dynamicToolCall" && item.id === itemId) return item;
    }
  }
  return null;
}

function renderToolDetail(panel: HTMLElement, call: Record<string, unknown>): void {
  const ownerDocument = panel.ownerDocument;
  const messages = rendererHarnessMessages(
    resolveRendererSettingsLocale(ownerDocument.defaultView?.navigator.languages ?? []),
  );
  const node = (tag: string, part: string, style: string, text: string): HTMLElement => {
    const element = ownerDocument.createElement(tag);
    element.setAttribute("data-part", part);
    element.style.cssText = style;
    element.textContent = text;
    return element;
  };
  const failed = call.status === "failed";
  const status = failed
    ? messages.toolFailed
    : call.status === "inProgress"
      ? messages.toolRunning
      : messages.toolCompleted;
  const tool = String(call.tool);
  const header = ownerDocument.createElement("div");
  header.append(
    node(
      "span",
      "tool",
      MONO_STYLE,
      typeof call.namespace === "string" ? `${call.namespace}.${tool}` : tool,
    ),
    " ",
    node(
      "span",
      "status",
      failed ? "color:var(--color-text-danger, #c2413b)" : LABEL_STYLE,
      status,
    ),
  );
  const children: HTMLElement[] = [
    header,
    node("div", "label", LABEL_STYLE, messages.toolParameters),
    node("pre", "parameters", TEXT_STYLE, JSON.stringify(call.arguments, null, 2)),
  ];
  const output = Array.isArray(call.contentItems) ? call.contentItems.filter(isRecord) : [];
  if (output.length > 0) children.push(node("div", "label", LABEL_STYLE, messages.toolOutput));
  for (const content of output) {
    if (typeof content.text === "string") {
      children.push(node("pre", "output", TEXT_STYLE, content.text));
    } else if (typeof content.imageUrl === "string") {
      const image = ownerDocument.createElement("img");
      image.setAttribute("data-part", "output");
      image.style.cssText = "display:block;max-width:100%;max-height:12rem;margin:2px 0 6px";
      image.src = content.imageUrl;
      image.alt = messages.toolOutput;
      children.push(image);
    }
  }
  panel.setAttribute("data-status", String(call.status));
  panel.replaceChildren(...children);
}

interface ToolDetailEntry {
  readonly row: ToolDetailRow;
  /** Puts back the row attributes and cursor this binding replaced. */
  readonly restore: () => void;
  panel: HTMLElement | null;
  /** Ends the conversation subscription of an open, still running call. */
  stop: (() => void) | null;
}

/**
 * Turns external Tool Execution rows that Desktop shows by name only into
 * disclosure buttons for a detail panel: tool name, status, parameters and
 * output of the row's exact Item id. Rows are found under the pointer and in
 * the transcript unit that holds keyboard focus, never by scanning the page.
 * Command Execution, File Change and native Codex Threads keep Desktop's own
 * UI. Each binding owns, and on disposal removes, only what it created.
 */
export function installRendererToolDetails(
  target: unknown,
  ownerDocument: Document | null,
): (() => void) | null {
  if (
    !ownerDocument ||
    !isRecord(target) ||
    typeof target.getConversation !== "function" ||
    typeof target.addConversationCallback !== "function"
  ) {
    // Older or changed Desktop builds keep showing the tool name only.
    return null;
  }
  const getConversation = target.getConversation as (threadId: string) => unknown;
  // Desktop calls back with the conversation after each state change.
  const addConversationCallback = target.addConversationCallback as (
    threadId: string,
    callback: (conversation: unknown) => void,
  ) => () => void;
  const entries = new Map<HTMLElement, ToolDetailEntry>();

  const close = (entry: ToolDetailEntry): void => {
    entry.stop?.();
    entry.stop = null;
    entry.panel?.remove();
    entry.panel = null;
    entry.row.element.setAttribute("aria-expanded", "false");
  };
  const release = (entry: ToolDetailEntry): void => {
    close(entry);
    entry.restore();
    entries.delete(entry.row.element);
  };
  const mark = (row: ToolDetailRow): ToolDetailEntry => {
    const existing = entries.get(row.element);
    if (existing?.row.itemId === row.itemId) return existing;
    for (const entry of entries.values()) {
      if (entry === existing || !entry.row.element.isConnected) release(entry);
    }
    const { element } = row;
    const attributes = ROW_MARK_ATTRIBUTES.map((name): [string, string | null] => [
      name,
      element.getAttribute(name),
    ]);
    const cursor = element.style.cursor;
    element.setAttribute(TOOL_DETAIL_ROW_ATTRIBUTE, row.itemId);
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-expanded", "false");
    element.style.cursor = "pointer";
    const entry: ToolDetailEntry = {
      row,
      restore: () => {
        for (const [name, value] of attributes) {
          if (value === null) element.removeAttribute(name);
          else element.setAttribute(name, value);
        }
        element.style.cursor = cursor;
      },
      panel: null,
      stop: null,
    };
    entries.set(element, entry);
    return entry;
  };
  const discover = (origin: Element): ToolDetailEntry | null => {
    const row = toolDetailRowFromElement(origin);
    if (!row) return null;
    const control = origin.closest(NATIVE_CONTROL_SELECTOR);
    if (control && !(control === row.element && entries.has(row.element))) return null;
    const conversation = getConversation.call(target, row.threadId);
    return isRecord(conversation) && conversation.modelProvider === "codexhost" ? mark(row) : null;
  };
  const toggle = (entry: ToolDetailEntry): void => {
    if (entry.panel) {
      close(entry);
      return;
    }
    const { element, threadId, itemId } = entry.row;
    let rendered = findExternalToolCall(getConversation.call(target, threadId), threadId, itemId);
    if (!rendered) return;
    const panel = ownerDocument.createElement("div");
    panel.setAttribute(TOOL_DETAIL_PANEL_ATTRIBUTE, itemId);
    panel.style.cssText = PANEL_STYLE;
    renderToolDetail(panel, rendered);
    element.after(panel);
    element.setAttribute("aria-expanded", "true");
    entry.panel = panel;
    if (rendered.status !== "inProgress") return;
    // A running call settles in conversation state, not necessarily in the
    // row's DOM. Follow the state until the call reaches a final status.
    entry.stop = addConversationCallback.call(target, threadId, (conversation) => {
      const call = element.isConnected
        ? findExternalToolCall(conversation, threadId, itemId)
        : null;
      if (!call) {
        release(entry);
        return;
      }
      if (call !== rendered) {
        rendered = call;
        renderToolDetail(panel, call);
      }
      if (call.status !== "inProgress") {
        entry.stop?.();
        entry.stop = null;
      }
    });
  };

  let focused: { unit: Element; observer: MutationObserver } | null = null;
  const onPointerOver = (event: Event): void => {
    if (event.target instanceof Element) discover(event.target);
  };
  const onClick = (event: Event): void => {
    const entry = event.target instanceof Element ? discover(event.target) : null;
    if (entry) toggle(entry);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const entry = event.target instanceof HTMLElement ? entries.get(event.target) : undefined;
    if (!entry) return;
    event.preventDefault();
    toggle(entry);
  };
  // Rows have no selector, and keyboard users never hover. While focus is in a
  // transcript unit, make that unit's rows reachable, including rows Desktop
  // renders after a group is expanded.
  const onFocusIn = (event: Event): void => {
    const unit =
      event.target instanceof Element ? event.target.closest(TRANSCRIPT_ITEM_SELECTOR) : null;
    if (unit === (focused?.unit ?? null)) return;
    focused?.observer.disconnect();
    focused = null;
    if (!unit) return;
    const scan = (): void => {
      for (const element of unit.querySelectorAll("*")) {
        if (!element.closest(`[${TOOL_DETAIL_ROW_ATTRIBUTE}]`)) discover(element);
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(unit, { childList: true, subtree: true });
    focused = { unit, observer };
    scan();
  };
  ownerDocument.addEventListener("pointerover", onPointerOver);
  ownerDocument.addEventListener("click", onClick);
  ownerDocument.addEventListener("keydown", onKeyDown);
  ownerDocument.addEventListener("focusin", onFocusIn);
  return () => {
    ownerDocument.removeEventListener("pointerover", onPointerOver);
    ownerDocument.removeEventListener("click", onClick);
    ownerDocument.removeEventListener("keydown", onKeyDown);
    ownerDocument.removeEventListener("focusin", onFocusIn);
    focused?.observer.disconnect();
    focused = null;
    for (const entry of entries.values()) release(entry);
  };
}
