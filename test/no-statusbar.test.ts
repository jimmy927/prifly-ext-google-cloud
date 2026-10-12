import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import { boardOf, setChoosing } from "../board";
import { apisRead } from "../errors-apis";
import { launchedOf, launchOf } from "../launch";
import { makeWorld, stat, type World } from "./board-world";
import { CLOUD_ACCOUNT, GMAIL_ONLY_ACCOUNT, serviceDisabled } from "./google-fake";

let world: World;
afterEach(() => {
  setChoosing(false);
  world.cleanup();
});

function boardIn(found: LaunchBoard | LaunchChoice[]): LaunchBoard {
  if (Array.isArray(found)) throw new Error(`Expected a board, got ${JSON.stringify(found)}`);
  return found;
}

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "prifly-extension.json"), "utf8"),
) as Record<string, unknown>;

describe("nothing in the status bar", () => {
  test("the manifest declares no panel and the module serves none", async () => {
    world = makeWorld({});
    expect(MANIFEST["panels"]).toBeUndefined();
    expect(Object.keys(await import("../index"))).not.toContain("panel");
  });

  test("every api.show passes an empty status bar", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    world.api.sessions = () => [{ id: "sess-1", title: "t", cwd: "/x", state: "idle" }];
    const { activate } = await import("../index");
    const stop = activate(world.api);
    await world.tick();
    launchedOf(world.api, "shop-prod/G1", "sess-1");
    stop();
    expect(world.fake.shown.length).toBeGreaterThanOrEqual(2);
    for (const shown of world.fake.shown) expect(shown.statusBar).toEqual([]);
  });
});

describe("the board carries what the panel showed", () => {
  test("the account and the default project open the board", async () => {
    world = makeWorld({ chosen: ["shop-prod", "shop-stage"] });
    await world.start();
    const account = boardIn(boardOf(world.api, "")).actions?.find(
      (each) => each.key === "info:account",
    );
    expect(account).toEqual({
      key: "info:account",
      title: "Reading as reader@example.com · default project shop-prod",
      tone: "muted",
    });
  });

  test("the APIs that are off show on their project's column, with the enable link", async () => {
    world = makeWorld({ chosen: ["shop-prod", "shop-stage"] });
    world.enabled["shop-prod"] = [
      "logging.googleapis.com",
      "run.googleapis.com",
      "bigquery.googleapis.com",
    ];
    await world.start();
    const board = boardIn(boardOf(world.api, ""));
    const rows = board.items.filter((item) => item.key.startsWith("apis:"));
    expect(rows).toEqual([
      {
        key: "apis:shop-prod",
        title: "Not enabled: Error Reporting, Compute Engine, Cloud Billing",
        group: "shop-prod",
        detail: "Switch them on to read this project",
        tone: "warning",
        url: "https://console.cloud.google.com/apis/library/clouderrorreporting.googleapis.com?project=shop-prod",
      },
    ]);
    const launch = await launchOf(world.api, "apis:shop-prod", "", { again: false });
    expect(launch.prompt).toBe("");
    const asked = world.conn.requests.find((each) => each.url.includes("shop-prod/services"));
    expect(new URL(asked?.url ?? "").searchParams.get("filter")).toBe("state:ENABLED");
  });

  test("a project with every API on has no APIs row", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    await world.start();
    const board = boardIn(boardOf(world.api, ""));
    expect(board.items.filter((item) => item.key.startsWith("apis:"))).toEqual([]);
  });

  test("while the APIs are being checked the column says so", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    const { startPoller, settled } = await import("../poll");
    const stop = startPoller(world.api);
    await settled();
    const row = boardIn(boardOf(world.api, "")).items.find((item) => item.key === "apis:shop-prod");
    expect(row).toEqual({
      key: "apis:shop-prod",
      title: "Checking the APIs…",
      group: "shop-prod",
      tone: "muted",
    });
    await apisRead();
    expect(
      boardIn(boardOf(world.api, "")).items.filter((item) => item.key.startsWith("apis:")),
    ).toEqual([]);
    stop();
  });

  test("an APIs check that failed is a warning row in the column, in the reader's terms", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.enabled["shop-prod"] = () => serviceDisabled("serviceusage.googleapis.com", "shop-prod");
    await world.start();
    const row = boardIn(boardOf(world.api, "")).items.find((item) => item.key === "apis:shop-prod");
    expect(row?.tone).toBe("warning");
    expect(row?.group).toBe("shop-prod");
    expect(row?.title).toContain("serviceusage.googleapis.com is not enabled");
  });

  test("only the APIs the project has on are taken off the list", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.enabled["shop-prod"] = ["run.googleapis.com"];
    await world.start();
    const row = boardIn(boardOf(world.api, "")).items.find((item) => item.key === "apis:shop-prod");
    expect(row?.title).not.toContain("Cloud Run");
    expect(row?.title).toContain("Compute Engine");
  });

  test("no projects chosen: the project rows (add / remove) are the board", async () => {
    world = makeWorld({});
    boardOf(world.api, "");
    const { projectsRead } = await import("../errors-projects");
    await projectsRead();
    const rows = boardOf(world.api, "");
    expect(Array.isArray(rows) ? rows.map((row) => row.key) : []).toEqual([
      "setup:add:shop-prod",
      "setup:add:shop-stage",
    ]);
  });
});

describe("sign-in missing: the board says so and offers the panel's action", () => {
  test("no Google account", async () => {
    world = makeWorld({ accounts: [] });
    expect(boardOf(world.api, "")).toEqual([
      { key: "setup:allow", title: "Allow Google Cloud for your Google account", tone: "info" },
    ]);
  });

  test("an account without the Cloud scope", async () => {
    world = makeWorld({ accounts: [{ ...GMAIL_ONLY_ACCOUNT }] });
    expect(boardOf(world.api, "")).toEqual([
      { key: "setup:allow", title: "Allow Google Cloud for reader@example.com", tone: "info" },
    ]);
    const launch = await launchOf(world.api, "setup:allow", "", { again: false });
    expect(launch.message).toBe("Signed in as reader@example.com");
    expect(world.conn.accounts[0]?.scopes).toContain(
      "https://www.googleapis.com/auth/cloud-platform",
    );
  });

  test("an ended grant", () => {
    world = makeWorld({ accounts: [{ ...CLOUD_ACCOUNT }] });
    world.conn.endpoint.revoke("google-1");
    expect(boardOf(world.api, "")).toEqual([
      { key: "setup:allow", title: "Sign in again as reader@example.com", tone: "warning" },
    ]);
  });

  test("a prifly without connections", () => {
    world = makeWorld({});
    const { connections: _gone, ...api } = world.api;
    expect(boardOf(api, "")).toEqual([
      {
        key: "setup:none",
        title: "This prifly has no Google connections: update prifly",
        tone: "muted",
      },
    ]);
  });
});
