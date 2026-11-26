import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkBuddyAdapter } from "@codexhost/adapter-workbuddy";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { codeBuddyPrimaryHistoryPath } from "../src/history.js";
import { CodeBuddyChildObserver } from "../src/subagent-history.js";

describe.each(["global", "cn"] as const)(
  "%s warmed child observer root identity",
  (distribution) => {
    it.each(["read", "locate"] as const)(
      "rejects %s after the root changes release and the child grows",
      async (operation) => {
        const home = await realpath(await mkdtemp(path.join(tmpdir(), "wb-child-root-")));
        const root = path.join(home, "data");
        const cwd = path.join(home, "Project");
        const environment = {
          HOME: home,
          [distribution === "cn" ? "WORKBUDDYCN_CONFIG_DIR" : "WORKBUDDY_CONFIG_DIR"]: root,
        };
        const adapter = new WorkBuddyAdapter({ distribution, environment });
        let warm: CodeBuddyChildObserver | undefined;
        let fresh: CodeBuddyChildObserver | undefined;
        try {
          const profile = adapter.options.profile;
          if (!profile) throw new Error("WorkBuddy Adapter must provide its product profile");
          await mkdir(cwd);
          const snapshot = path.join(root, "cache", "acc-product-config-v3.json");
          await mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
          const own = distribution === "cn" ? ".workbuddy" : ".workbuddy-ai";
          const foreign = distribution === "cn" ? ".workbuddy-ai" : ".workbuddy";
          await writeFile(snapshot, JSON.stringify({ dataFolderName: own }), { mode: 0o600 });
          const parent = nativeSessionRefSchema.parse({
            harnessId: profile.harnessId,
            nativeSessionId: "parent",
            formatVersion: 1,
          });
          const parentFile = codeBuddyPrimaryHistoryPath(cwd, parent, environment, profile);
          const children = path.join(path.dirname(parentFile), "parent", "subagents");
          await mkdir(children, { recursive: true });
          await writeFile(
            parentFile,
            JSON.stringify({
              id: "parent-user",
              type: "message",
              role: "user",
              content: "delegate",
              cwd,
              sessionId: "parent",
            }) + "\n",
          );
          const child = path.join(children, "agent-child.jsonl");
          await writeFile(
            child,
            JSON.stringify({
              id: "child-user",
              type: "message",
              role: "user",
              content: "INITIAL-CHILD",
              cwd,
              sessionId: "native-child",
              providerData: { conversationRequestId: "request-1" },
            }) + "\n",
          );
          warm = new CodeBuddyChildObserver(parent, cwd, environment, profile);
          expect(await warm.locate("request-1")).toBe("agent-child");
          expect(JSON.stringify(await warm.read("agent-child", "running"))).toContain(
            "INITIAL-CHILD",
          );
          // The parent bytes and version stay unchanged, so the same observer uses its cache.
          await writeFile(snapshot, JSON.stringify({ dataFolderName: foreign }));
          await appendFile(
            child,
            JSON.stringify({
              id: "child-answer",
              parentId: "child-user",
              type: "message",
              role: "assistant",
              content: "FOREIGN-AFTER-WARMUP",
              cwd,
              sessionId: "native-child",
            }) + "\n",
          );
          const poll = (observer: CodeBuddyChildObserver) =>
            operation === "read"
              ? observer.read("agent-child", "running")
              : observer.locate("request-1");
          await expect(poll(warm)).rejects.toMatchObject({ code: "invalidRequest" });
          fresh = new CodeBuddyChildObserver(parent, cwd, environment, profile);
          await expect(poll(fresh)).rejects.toMatchObject({ code: "invalidRequest" });
        } finally {
          warm?.close();
          fresh?.close();
          await adapter.close();
          await rm(home, { recursive: true, force: true });
        }
      },
    );
  },
);
