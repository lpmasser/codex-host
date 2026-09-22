import { mkdtemp, mkdir, readFile, readlink, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityAccountProfiles, ProfileImportError } from "../src/account-profiles.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-profiles-test-"));
  directories.push(root);
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  await mkdir(path.join(home, ".gemini", "antigravity-cli", "cache"));
  await writeFile(
    path.join(home, ".gemini", "antigravity-cli", "cache", "antigravity-keyring-unavailable"),
    "GLOBAL MARKER",
  );
  await writeFile(
    path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    "SYNTHETIC GLOBAL CREDENTIAL",
  );
  await writeFile(
    path.join(home, ".gemini", "jetski-standalone-oauth-token"),
    "SYNTHETIC LEGACY CREDENTIAL",
  );
  await writeFile(path.join(home, ".gitconfig"), "fixture developer config");
  const environment = { HOME: home, CODEXHOST_DATA_DIR: path.join(root, "data") };
  const profiles = new AntigravityAccountProfiles({
    environment,
    authenticate: async ({ email, refresh_token }) => {
      if (refresh_token === "invalid") throw new ProfileImportError("authenticationFailed");
      return { email, serialized: JSON.stringify({ synthetic: refresh_token }) };
    },
  });
  const index = path.join(root, "data", "antigravity-profiles", "profiles.json");
  return { root, home, profiles, environment, index };
}
const input = (...emails: string[]) =>
  JSON.stringify(emails.map((email) => ({ email, refresh_token: "synthetic" })));

describe("AGM account Profiles", () => {
  it("imports separate identities and shares developer config without sharing credentials", async () => {
    const { profiles, home } = await fixture();
    expect(await profiles.select()).toBeUndefined();
    const result = await profiles.importJson(
      input("a@example.com", "b@example.com", "c@example.com"),
    );
    expect(result.map((r) => r.status)).toEqual(["imported", "imported", "imported"]);
    const ids = [await profiles.select(), await profiles.select(), await profiles.select()];
    expect(new Set(ids).size).toBe(3);
    const concurrent = await Promise.all([profiles.select(), profiles.select(), profiles.select()]);
    expect(new Set(concurrent)).toEqual(new Set(ids));
    expect(await profiles.select()).toBe(ids[0]);
    for (const id of ids) {
      const lease = await profiles.acquire(id as string);
      expect(await readlink(path.join(lease.home, ".gitconfig"))).toBe(
        path.join(home, ".gitconfig"),
      );
      expect((await stat(path.join(lease.home, ".gemini"))).isDirectory()).toBe(true);
      expect((await stat(lease.home)).mode & 0o777).toBe(0o700);
      const credentialPath = path.join(
        lease.home,
        ".gemini",
        "antigravity-cli",
        "antigravity-oauth-token",
      );
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(credentialPath, "utf8")).not.toContain("GLOBAL");
      expect(await readdir(path.join(lease.home, ".gemini"))).not.toContain(
        "jetski-standalone-oauth-token",
      );
      expect(
        await readdir(path.join(lease.home, ".gemini", "antigravity-cli", "cache")),
      ).not.toContain("antigravity-keyring-unavailable");
      const accounts = JSON.parse(
        await readFile(path.join(lease.home, ".gemini", "google_accounts.json"), "utf8"),
      );
      expect(result.map((r) => r.label)).toContain(accounts.active);
      lease.release();
    }
  });

  it("retains identity on reimport, rejects active replacement and preserves invalid refresh failures", async () => {
    const { profiles, index } = await fixture();
    await profiles.importJson(input("a@example.com"));
    const id = (await profiles.select()) as string;
    const before = await readFile(index, "utf8");
    const lease = await profiles.acquire(id);
    const credentialPath = path.join(
      lease.home,
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token",
    );
    const originalCredential = await readFile(credentialPath, "utf8");
    expect((await profiles.importJson(input("a@example.com")))[0]?.error).toBe("profileBusy");
    lease.release();
    expect((await profiles.importJson(input("A@example.com")))[0]?.status).toBe("updated");
    expect(await profiles.select()).toBe(id);
    const failure = await profiles.importJson(
      JSON.stringify([{ email: "a@example.com", refresh_token: "invalid" }]),
    );
    expect(failure[0]?.error).toBe("authenticationFailed");
    expect(await readFile(credentialPath, "utf8")).toBe(originalCredential);
    expect(await readFile(index, "utf8")).toBe(before);
  });

  it("fails closed for missing profiles and corrupt indexes after restart", async () => {
    const { profiles, environment, index } = await fixture();
    await profiles.importJson(input("a@example.com"));
    const id = (await profiles.select()) as string;
    const restored = new AntigravityAccountProfiles({
      environment,
      authenticate: async () => {
        throw new Error("unused");
      },
    });
    const lease = await restored.acquire(id);
    lease.release();
    await expect(restored.acquire("missing")).rejects.toThrow("missing");
    await writeFile(index, "corrupt");
    await expect(restored.select()).rejects.toThrow("unreadable");
  });

  it("rejects malformed and conflicting imports without creating an identity", async () => {
    const { profiles, root } = await fixture();
    await expect(profiles.importJson("[]")).rejects.toThrow("export array");
    await expect(profiles.importJson('{"refresh_token":"DO-NOT-ECHO"}')).rejects.toThrow(
      "export array",
    );
    const result = await profiles.importJson(
      JSON.stringify([
        { email: "a@example.com", refresh_token: "one" },
        { email: "A@example.com", refresh_token: "two" },
        { email: "bad" },
      ]),
    );
    expect(result.map((r) => r.error)).toEqual(["conflictingEntries", "invalidEntry"]);
    expect(await profiles.select()).toBeUndefined();
    expect(await readdir(root)).toEqual(["home"]);
  });

  it("preserves Library siblings when the Host data directory is nested there", async () => {
    const { home } = await fixture();
    const preferences = path.join(home, "Library", "Preferences");
    await mkdir(preferences, { recursive: true });
    await writeFile(path.join(preferences, "developer-fixture"), "shared");
    const directory = path.join(home, "Library", "Application Support", "codexhost");
    const profiles = new AntigravityAccountProfiles({
      environment: { HOME: home, CODEXHOST_DATA_DIR: directory },
      authenticate: async ({ email }) => ({ email, serialized: "synthetic" }),
    });
    await profiles.importJson(input("a@example.com"));
    const lease = await profiles.acquire((await profiles.select()) as string);
    try {
      expect(
        await readFile(
          path.join(lease.home, "Library", "Preferences", "developer-fixture"),
          "utf8",
        ),
      ).toBe("shared");
      expect(
        await readdir(path.join(lease.home, "Library", "Application Support", "codexhost")),
      ).toEqual([]);
    } finally {
      lease.release();
    }
  });
});
