import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activate } from "../index";
import { writeChosen } from "../settings";
import { startStatus } from "../status";
import { fakeApi, fakeConnections } from "./fake-api";
import { CLOUD_ACCOUNT, fakeGoogle, GMAIL_ONLY_ACCOUNT, json } from "./google-fake";
import { cleanUp, temp } from "./harness";

afterEach(cleanUp);

const ROOT = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "prifly-extension.json"), "utf8")) as Record<
  string,
  unknown
>;

const PROJECTS = fakeGoogle([
  {
    url: /projects:search/,
    answer: () => json({ projects: [{ projectId: "shop-prod" }, { projectId: "shop-dev" }] }),
  },
]);

/** Let the status line's first read finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("a toolbox, no UI", () => {
  test("the manifest has no launcher, panel, menu or settings, and names the prompt", () => {
    for (const key of ["launch", "panels", "menu", "snooze", "settings"]) {
      expect(manifest[key]).toBeUndefined();
    }
    expect(manifest["prompt"]).toBe("prompt.md");
    expect(existsSync(join(ROOT, "prompt.md"))).toBe(true);
  });

  test("the module exports only activate", async () => {
    expect(Object.keys(await import("../index"))).toEqual(["activate"]);
  });

  test("the board, launcher and poller files are gone", () => {
    for (const file of [
      "board.ts",
      "launch.ts",
      "poll.ts",
      "errors-group.ts",
      "errors-prompt.ts",
    ]) {
      expect(existsSync(join(ROOT, file))).toBe(false);
    }
  });

  test("activate registers tools and a status line, and shows, flags or notifies nothing", async () => {
    const folder = temp();
    writeChosen(folder, { projects: [], defaultProject: "shop-prod" });
    const connections = fakeConnections({ accounts: [CLOUD_ACCOUNT], provider: PROJECTS });
    const fake = fakeApi({ connections: connections.connections, folder });
    const stop = activate(fake.api);
    await settle();
    expect(fake.tools().length).toBeGreaterThan(10);
    expect(fake.shown).toEqual([]);
    expect(fake.flags.size).toBe(0);
    expect(fake.notices).toEqual([]);
    expect(fake.statuses.at(-1)).toBe("Connected · 2 projects · default shop-prod");

    // Setting the default project says the line again without asking Google.
    const before = connections.requests.length;
    expect(await fake.callTool("gcloud_default_project", { project: "shop-dev" })).toBe(
      "The default project is now shop-dev.",
    );
    expect(fake.statuses.at(-1)).toBe("Connected · 2 projects · default shop-dev");
    expect(connections.requests.length).toBe(before);
    stop();
  });

  test("the prompt sends sessions to the docs, then the generic call, with a confirm on writes", () => {
    const prompt = readFileSync(join(ROOT, "prompt.md"), "utf8");
    expect(prompt).toContain("`gcloud_api_docs` first");
    expect(prompt).toContain("then `gcloud_api`");
    expect(prompt).toContain("confirm card");
    expect(prompt).toContain("not the gcloud CLI");
  });
});

describe("the status line", () => {
  test("not connected says why, and reads nothing", async () => {
    const connections = fakeConnections({ accounts: [GMAIL_ONLY_ACCOUNT], provider: PROJECTS });
    const fake = fakeApi({ connections: connections.connections, folder: temp() });
    const status = startStatus(fake.api);
    await status.refresh();
    status.stop();
    expect(fake.statuses.at(-1)).toBe(
      "Not connected: reader@example.com is not allowed for Google Cloud",
    );
    expect(connections.requests).toHaveLength(0);
  });

  test("Google is asked again only on the timer", async () => {
    const connections = fakeConnections({ accounts: [CLOUD_ACCOUNT], provider: PROJECTS });
    const fake = fakeApi({ connections: connections.connections, folder: temp() });
    let tick: (() => void) | null = null;
    let every = 0;
    let stopped = false;
    const status = startStatus(fake.api, (given, ms) => {
      tick = given;
      every = ms;
      return () => {
        stopped = true;
      };
    });
    await settle();
    expect(every).toBe(15 * 60 * 1000);
    expect(connections.requests).toHaveLength(1);
    expect(fake.statuses.at(-1)).toBe("Connected · 2 projects · no default project");
    status.redraw();
    expect(connections.requests).toHaveLength(1);
    (tick as (() => void) | null)?.();
    await settle();
    expect(connections.requests).toHaveLength(2);
    status.stop();
    expect(stopped).toBe(true);
  });

  test("a project list that fails is a short line and a log, not a throw", async () => {
    const connections = fakeConnections({
      accounts: [CLOUD_ACCOUNT],
      provider: () => json({ error: { code: 500, message: "backend" } }, 500),
    });
    const fake = fakeApi({ connections: connections.connections, folder: temp() });
    const status = startStatus(fake.api);
    await status.refresh();
    status.stop();
    expect(fake.statuses.at(-1)).toBe("Connected · projects unreadable · no default project");
    expect(fake.logs.some((each) => each.event === "status_projects_failed")).toBe(true);
  });
});
