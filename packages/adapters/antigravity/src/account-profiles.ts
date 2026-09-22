import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessAccountProfiles } from "@codexhost/harness-adapter";
import {
  ACCOUNT_PROFILE_IMPORT_MAX_BYTES,
  type AccountProfileImportEntry,
} from "@codexhost/shared-contracts";
import { z } from "zod";

const profileSchema = z.object({ id: z.uuid(), email: z.email().max(320) }).strict();
const profilesSchema = z.array(profileSchema);
const importEntrySchema = z.object({ email: z.email().max(320), refresh_token: z.string().min(1) });
type Profile = z.infer<typeof profileSchema>;
const NATIVE_TOKEN_FILENAME = "antigravity-oauth-token";
export type AgmAccount = z.infer<typeof importEntrySchema>;
export interface ImportedAgmCredential {
  email: string;
  /** Complete AGY-native serialized credential, never a bare refresh token. */
  serialized: string;
}

export class ProfileImportError extends Error {
  constructor(readonly reason: NonNullable<AccountProfileImportEntry["error"]>) {
    super(reason);
  }
}

/** CAAM shallow-home layout: real identity files, shared non-auth developer state. */
async function linkEntries(
  source: string,
  target: string,
  excluded: Set<string>,
  privateDirectory?: string,
): Promise<void> {
  const entries = await readdir(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of entries) {
    if (
      !excluded.has(name) &&
      !name.startsWith("keyring-marker-") &&
      !name.endsWith("-keyring-unavailable")
    ) {
      const from = path.join(source, name);
      const to = path.join(target, name);
      const relative = privateDirectory ? path.relative(from, privateDirectory) : null;
      if (relative === "") continue;
      if (
        relative !== null &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        await mkdir(to, { mode: 0o700 });
        await linkEntries(from, to, new Set(), privateDirectory);
      } else {
        await symlink(from, to);
      }
    }
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class AntigravityAccountProfiles implements HarnessAccountProfiles {
  readonly #directory: string;
  readonly #realHome: string;
  readonly #geminiHome: string;
  readonly #authenticate: (account: AgmAccount) => Promise<ImportedAgmCredential>;
  readonly #leases = new Map<string, number>();
  readonly #updating = new Set<string>();
  #imports: Promise<unknown> = Promise.resolve();
  #cursor = 0;

  constructor(input: {
    environment: NodeJS.ProcessEnv;
    authenticate(account: AgmAccount): Promise<ImportedAgmCredential>;
  }) {
    this.#realHome =
      (process.platform === "win32" ? input.environment.USERPROFILE : input.environment.HOME) ??
      os.homedir();
    this.#geminiHome = input.environment.GEMINI_HOME ?? path.join(this.#realHome, ".gemini");
    this.#directory = path.join(
      input.environment.CODEXHOST_DATA_DIR ?? path.join(os.homedir(), ".codexhost"),
      "antigravity-profiles",
    );
    this.#authenticate = input.authenticate;
  }

  async #list(): Promise<Profile[]> {
    try {
      return profilesSchema.parse(
        JSON.parse(await readFile(path.join(this.#directory, "profiles.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Antigravity Profile index is unreadable");
    }
  }

  async hasProfiles(): Promise<boolean> {
    return (await this.#list()).length > 0;
  }

  /** A stable catalogue source; browsing models does not allocate a new Thread. */
  async catalogProfile(): Promise<string | undefined> {
    return (await this.#list())[0]?.id;
  }

  async select(): Promise<string | undefined> {
    const profiles = await this.#list();
    if (profiles.length === 0) return undefined;
    const profile = profiles[this.#cursor % profiles.length] as Profile;
    this.#cursor += 1;
    return profile.id;
  }

  /** Holding a lease prevents import from replacing credentials used by a native process. */
  async acquire(id: string): Promise<{ home: string; release(): void }> {
    if (!(await this.#list()).some((profile) => profile.id === id)) {
      throw new Error("Bound Antigravity Profile is missing; import that account again");
    }
    if (this.#updating.has(id)) throw new ProfileImportError("profileBusy");
    const home = path.join(this.#directory, id);
    const token = await stat(path.join(home, ".gemini", "antigravity-cli", NATIVE_TOKEN_FILENAME));
    if (!token.isFile() || token.size === 0)
      throw new Error("Bound Antigravity Profile credentials are missing");
    if (this.#updating.has(id)) throw new ProfileImportError("profileBusy");
    this.#leases.set(id, (this.#leases.get(id) ?? 0) + 1);
    let released = false;
    return {
      home,
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.#leases.get(id) as number) - 1;
        if (remaining === 0) this.#leases.delete(id);
        else this.#leases.set(id, remaining);
      },
    };
  }

  importJson(content: string): Promise<AccountProfileImportEntry[]> {
    const operation = this.#imports.then(() => this.#import(content));
    this.#imports = operation.catch(() => undefined);
    return operation;
  }

  async #import(content: string): Promise<AccountProfileImportEntry[]> {
    if (Buffer.byteLength(content) > ACCOUNT_PROFILE_IMPORT_MAX_BYTES) {
      throw new Error("Antigravity Manager export exceeds 1 MiB");
    }
    let entries: unknown[];
    try {
      entries = z.array(z.unknown()).min(1).max(100).parse(JSON.parse(content));
    } catch {
      throw new Error("Expected an Antigravity Manager account export array");
    }
    const parsed = entries.map((entry) => importEntrySchema.safeParse(entry));
    const byEmail = new Map<string, Set<string>>();
    for (const entry of parsed) {
      if (!entry.success) continue;
      const email = entry.data.email.toLowerCase();
      const tokens = byEmail.get(email) ?? new Set<string>();
      tokens.add(entry.data.refresh_token);
      byEmail.set(email, tokens);
    }
    const profiles = await this.#list();
    const results: AccountProfileImportEntry[] = [];
    const imported = new Set<string>();
    for (const entry of parsed) {
      if (!entry.success) {
        results.push({ label: "", status: "failed", error: "invalidEntry" });
        continue;
      }
      const account = entry.data;
      const email = account.email.toLowerCase();
      if (imported.has(email)) continue;
      imported.add(email);
      if ((byEmail.get(email) as Set<string>).size > 1) {
        results.push({ label: account.email, status: "failed", error: "conflictingEntries" });
        continue;
      }
      const existing = profiles.find((profile) => profile.email.toLowerCase() === email);
      if (existing && this.#leases.has(existing.id)) {
        results.push({ label: account.email, status: "failed", error: "profileBusy" });
        continue;
      }
      const id = existing?.id ?? randomUUID();
      this.#updating.add(id);
      try {
        const credential = await this.#authenticate(account);
        await this.#publish(
          { id, email: credential.email },
          credential.serialized,
          profiles,
          Boolean(existing),
        );
        if (!existing) profiles.push({ id, email: credential.email });
        results.push({ label: credential.email, status: existing ? "updated" : "imported" });
      } catch (error) {
        results.push({
          label: account.email,
          status: "failed",
          error: error instanceof ProfileImportError ? error.reason : "writeFailed",
        });
      } finally {
        this.#updating.delete(id);
      }
    }
    return results;
  }

  async #publish(
    profile: Profile,
    credential: string,
    profiles: Profile[],
    existing: boolean,
  ): Promise<void> {
    const home = path.join(this.#directory, profile.id);
    const token = path.join(home, ".gemini", "antigravity-cli", NATIVE_TOKEN_FILENAME);
    if (existing) {
      await atomicWrite(token, credential);
      return;
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const staging = path.join(this.#directory, `.import-${randomUUID()}`);
    let published = false;
    try {
      const gemini = path.join(staging, ".gemini");
      const agy = path.join(gemini, "antigravity-cli");
      await mkdir(staging, { mode: 0o700 });
      await mkdir(gemini, { mode: 0o700 });
      await mkdir(agy, { mode: 0o700 });
      await mkdir(path.join(gemini, "cache"), { mode: 0o700 });
      await mkdir(path.join(agy, "cache"), { mode: 0o700 });
      const excluded = new Set([".gemini", ".codexhost", ".caam", "orch-homes"]);
      await linkEntries(this.#realHome, staging, excluded, this.#directory);
      await linkEntries(
        this.#geminiHome,
        gemini,
        new Set([
          "antigravity-cli",
          "cache",
          "google_accounts.json",
          "oauth_creds.json",
          "jetski-standalone-oauth-token",
        ]),
      );
      await linkEntries(
        path.join(this.#geminiHome, "antigravity-cli"),
        agy,
        new Set(["antigravity-oauth-token", "settings.json", "cache"]),
      );
      await linkEntries(
        path.join(this.#geminiHome, "cache"),
        path.join(gemini, "cache"),
        new Set(),
      );
      await linkEntries(
        path.join(this.#geminiHome, "antigravity-cli", "cache"),
        path.join(agy, "cache"),
        new Set(),
      );
      await writeFile(path.join(agy, NATIVE_TOKEN_FILENAME), credential, { mode: 0o600 });
      await writeFile(
        path.join(gemini, "google_accounts.json"),
        JSON.stringify({ active: profile.email, old: [] }),
        { mode: 0o600 },
      );
      await rename(staging, home);
      published = true;
      await atomicWrite(
        path.join(this.#directory, "profiles.json"),
        JSON.stringify([...profiles, profile]),
      );
    } catch (error) {
      if (published) await rm(home, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
