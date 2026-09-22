import {
  ACCOUNT_PROFILE_IMPORT_MAX_BYTES,
  type AccountProfileImportEntry,
  type AccountProfilesParams,
  type AccountProfilesResult,
} from "@codexhost/shared-contracts";
import type { AccountProfileImportMessages } from "./account-profile-import-messages.js";

export interface RendererAccountProfileClient {
  /** Always served by the local Host; credentials never travel through a remote route. */
  accountProfiles?(params: AccountProfilesParams): Promise<AccountProfilesResult>;
}

/**
 * One-shot import of an Antigravity Manager export. File contents live only in the change
 * handler; the page keeps nothing but the per-account metadata the Host returns.
 */
export function mountAccountProfileImport(
  document: Document,
  signal: AbortSignal,
  getClient: () => RendererAccountProfileClient | null,
  messages: AccountProfileImportMessages,
) {
  const section = document.createElement("section");
  section.className = "settings-account-profile-import";
  section.hidden = true;
  section.setAttribute("aria-label", messages.title);
  const title = document.createElement("strong");
  title.textContent = messages.title;
  const hint = document.createElement("p");
  hint.className = "settings-account-status";
  hint.textContent = messages.hint;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-command-button settings-command-button--secondary";
  button.textContent = messages.choose;
  button.addEventListener("click", () => input.click());
  const status = document.createElement("p");
  status.className = "settings-account-status";
  status.setAttribute("aria-live", "polite");
  const results = document.createElement("ul");
  results.className = "settings-account-profile-import__results";
  section.append(title, hint, button, input, status, results);

  let busy = false;
  const setBusy = (value: boolean): void => {
    busy = value;
    button.disabled = value;
    input.disabled = value;
  };
  const show = (message: string, entries: readonly AccountProfileImportEntry[] = []): void => {
    status.textContent = message;
    results.replaceChildren(
      ...entries.map((entry) => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = entry.label || messages.unknownLabel;
        const outcome = document.createElement("span");
        outcome.textContent =
          entry.status === "imported"
            ? messages.imported
            : entry.status === "updated"
              ? messages.updated
              : `${messages.failedEntry}${entry.error ? ` · ${messages.errors[entry.error]}` : ""}`;
        item.dataset.status = entry.status;
        item.append(label, " — ", outcome);
        return item;
      }),
    );
  };

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    // A cancelled picker or a second pick during an import changes nothing.
    if (!file || busy || signal.aborted) return;
    if (file.size > ACCOUNT_PROFILE_IMPORT_MAX_BYTES) return show(messages.tooLarge);
    const client = getClient();
    if (!client?.accountProfiles) return show(messages.failed);
    const accountProfiles = client.accountProfiles.bind(client);
    setBusy(true);
    show(messages.importing);
    void (async () => {
      let content: string;
      try {
        content = await file.text();
      } catch {
        return messages.readFailed;
      }
      if (!content.trim()) return messages.emptyFile;
      try {
        const result = await accountProfiles({
          action: "import",
          harnessId: "antigravity",
          content,
        });
        return result.results.length ? result.results : messages.noEntries;
      } catch {
        // Host and parser errors may echo request data; show only a fixed message.
        return messages.failed;
      }
    })().then((outcome) => {
      if (signal.aborted) return;
      setBusy(false);
      if (typeof outcome === "string") show(outcome);
      else show("", outcome);
    });
  });

  return {
    section,
    async refresh(): Promise<void> {
      const client = getClient();
      let available = false;
      try {
        available =
          !!client?.accountProfiles &&
          (await client.accountProfiles({ action: "status", harnessId: "antigravity" })).available;
      } catch {
        // Hosts without the import method simply do not offer it.
      }
      if (!signal.aborted) section.hidden = !available;
    },
  };
}
