import type { AccountProfilesParams, AccountProfilesResult } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  accountProfileImportChinese,
  accountProfileImportEnglish,
} from "../../src/settings/account-profile-import-messages.js";
import { mountAccountProfileImport } from "../../src/settings/account-profile-import.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  className = "";
  hidden = false;
  disabled = false;
  textContent = "";
  type = "";
  accept = "";
  value = "";
  files: { size: number; text(): Promise<string> }[] | null = null;
  constructor(readonly tagName: string) {}
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  append(...children: unknown[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: unknown[]): void {
    this.children.splice(0, this.children.length, ...children);
  }
  setAttribute(): void {}
  click(): void {
    this.listeners.get("click")?.();
  }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) };
const text = (node: unknown): string =>
  typeof node === "string"
    ? node
    : node instanceof FakeElement
      ? node.textContent + node.children.map(text).join("")
      : "";
const find = (root: FakeElement, tag: string): FakeElement =>
  root.children.find(
    (child) => child instanceof FakeElement && child.tagName === tag,
  ) as FakeElement;
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
const file = (content: string, size = content.length) => ({ size, text: async () => content });

function mount(
  accountProfiles: (params: AccountProfilesParams) => Promise<AccountProfilesResult>,
  messages = accountProfileImportEnglish,
) {
  const scope = new AbortController();
  const controls = mountAccountProfileImport(
    fakeDocument as unknown as Document,
    scope.signal,
    () => ({ accountProfiles }),
    messages,
  );
  const section = controls.section as unknown as FakeElement;
  const input = find(section, "input");
  const button = find(section, "button");
  const pick = (selected: ReturnType<typeof file> | null) => {
    input.value = "C:\\fakepath\\accounts.json";
    input.files = selected ? [selected] : [];
    input.listeners.get("change")?.();
  };
  return { controls, section, input, button, pick, scope };
}

describe("Antigravity Manager account import", () => {
  it("is offered only when the local Host reports it available", async () => {
    for (const status of [
      async () => ({ available: false, results: [] }),
      async () => Promise.reject(new Error("unsupported")),
    ]) {
      const { controls, section } = mount(vi.fn(status));
      await controls.refresh();
      expect(section.hidden).toBe(true);
    }
    const accountProfiles = vi.fn(async () => ({ available: true, results: [] }));
    const { controls, section } = mount(accountProfiles);
    await controls.refresh();
    expect(section.hidden).toBe(false);
    expect(accountProfiles).toHaveBeenCalledWith({ action: "status", harnessId: "antigravity" });
  });

  it("imports once, clears the input and shows localized per-account results", async () => {
    let finish!: (result: AccountProfilesResult) => void;
    const accountProfiles = vi.fn(
      () => new Promise<AccountProfilesResult>((resolve) => (finish = resolve)),
    );
    const { section, input, button, pick } = mount(accountProfiles, accountProfileImportChinese);
    const content = '[{"email":"a@example.com","refresh_token":"secret-token"}]';
    pick(file(content));
    expect(input.value).toBe("");
    await wait();
    expect(button.disabled).toBe(true);
    pick(file(content));
    expect(accountProfiles).toHaveBeenCalledTimes(1);
    expect(accountProfiles).toHaveBeenCalledWith({
      action: "import",
      harnessId: "antigravity",
      content,
    });
    finish({
      available: true,
      results: [
        { label: "a@example.com", status: "imported" },
        { label: "b@example.com", status: "updated" },
        { label: "c@example.com", status: "failed", error: "authenticationFailed" },
        { label: "", status: "failed", error: "invalidEntry" },
      ],
    });
    await wait();
    const rendered = text(section);
    expect(button.disabled).toBe(false);
    expect(rendered).toContain("a@example.com — 已导入");
    expect(rendered).toContain("b@example.com — 已更新");
    expect(rendered).toContain(
      `c@example.com — 失败 · ${accountProfileImportChinese.errors.authenticationFailed}`,
    );
    expect(rendered).toContain("（无邮箱）");
    expect(rendered).not.toContain("secret-token");
  });

  it("ignores a cancelled picker and rejects empty or oversized files locally", async () => {
    const accountProfiles = vi.fn(async () => ({ available: true, results: [] }));
    const { section, pick } = mount(accountProfiles);
    pick(null);
    expect(text(section)).not.toContain(accountProfileImportEnglish.importing);
    pick(file("x", 1_048_577));
    expect(text(section)).toContain(accountProfileImportEnglish.tooLarge);
    pick(file("  \n"));
    await wait();
    expect(text(section)).toContain(accountProfileImportEnglish.emptyFile);
    expect(accountProfiles).not.toHaveBeenCalled();
  });

  it("never echoes Host errors that may contain credentials", async () => {
    const accountProfiles = vi.fn(async () => {
      throw new Error('bad refresh_token "secret-token"');
    });
    const { section, pick } = mount(accountProfiles);
    pick(file('[{"email":"a@example.com","refresh_token":"secret-token"}]'));
    await wait();
    expect(text(section)).toContain(accountProfileImportEnglish.failed);
    expect(text(section)).not.toContain("secret-token");
  });
});
