import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import { boardOf, setChoosing } from "../board";
import { projectsRead } from "../errors-projects";
import { launchOf } from "../launch";
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

function rowsIn(found: LaunchBoard | LaunchChoice[]): LaunchChoice[] {
  if (!Array.isArray(found)) throw new Error("Expected setup rows, got a board");
  return found;
}

describe("setup rows", () => {
  test("no Google account: allow Google Cloud for your Google account", () => {
    world = makeWorld({ accounts: [] });
    const rows = rowsIn(boardOf(world.api, ""));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("setup:allow");
    expect(rows[0]?.title).toBe("Allow Google Cloud for your Google account");
  });

  test("an account without the Cloud scope names the account", () => {
    world = makeWorld({ accounts: [{ ...GMAIL_ONLY_ACCOUNT }] });
    const rows = rowsIn(boardOf(world.api, ""));
    expect(rows[0]?.key).toBe("setup:allow");
    expect(rows[0]?.title).toBe("Allow Google Cloud for reader@example.com");
  });

  test("an ended grant asks to sign in again, and a click on the row fixes it", async () => {
    world = makeWorld({ accounts: [{ ...CLOUD_ACCOUNT }] });
    world.conn.endpoint.revoke("google-1");
    const rows = rowsIn(boardOf(world.api, ""));
    expect(rows[0]?.key).toBe("setup:allow");
    expect(rows[0]?.title).toBe("Sign in again as reader@example.com");
    const launch = await launchOf(world.api, "setup:allow", "", { again: false });
    expect(launch.prompt).toBe("");
    expect(launch.message).toBe("Signed in as reader@example.com");
    expect(Array.isArray(boardOf(world.api, ""))).toBe(true);
    expect(rowsIn(boardOf(world.api, ""))[0]?.key).not.toBe("setup:allow");
  });

  test("no projects chosen: reading row, then one add row per project; a click writes state.json", async () => {
    world = makeWorld({});
    const reading = rowsIn(boardOf(world.api, ""));
    expect(reading).toHaveLength(1);
    expect(reading[0]).toMatchObject({
      key: "setup:reading",
      title: "Reading your projects…",
      tone: "muted",
    });
    await projectsRead();
    const rows = rowsIn(boardOf(world.api, ""));
    expect(rows.map((row) => row.key)).toEqual(["setup:add:shop-prod", "setup:add:shop-stage"]);
    expect(rows[0]?.title).toBe("Show shop-prod on the board");

    const launch = await launchOf(world.api, "setup:add:shop-prod", "", { again: false });
    expect(launch.prompt).toBe("");
    expect(launch.message).toContain("shop-prod");
    const saved = JSON.parse(readFileSync(join(world.folder, "state.json"), "utf8"));
    expect(saved).toEqual({ projects: ["shop-prod"], defaultProject: "shop-prod" });
  });

  test("Choose projects… lists add and remove rows", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    await world.start();
    await launchOf(world.api, "setup:projects", "", { again: false });
    boardOf(world.api, "");
    await projectsRead();
    const rows = rowsIn(boardOf(world.api, ""));
    expect(rows.map((row) => row.key)).toEqual([
      "setup:remove:shop-prod",
      "setup:add:shop-stage",
      "setup:done",
    ]);
    await launchOf(world.api, "setup:remove:shop-prod", "", { again: false });
    expect(JSON.parse(readFileSync(join(world.folder, "state.json"), "utf8")).projects).toEqual([]);
  });
});

describe("the board", () => {
  test("before the first poll has answered: one muted row", () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    const rows = rowsIn(boardOf(world.api, ""));
    expect(rows).toEqual([{ key: "loading", title: "Reading Error Reporting…", tone: "muted" }]);
  });

  test("columns are the chosen projects; cards carry the group's face", async () => {
    world = makeWorld({ chosen: ["shop-prod", "shop-stage"] });
    world.stats["shop-prod"] = {
      day: [stat("G1")],
      hour: [
        stat("G1", {
          count: "6",
          timedCounts: [{ count: "6", startTime: "2026-10-11T11:50:00Z" }],
        }),
      ],
      week: [stat("G1", { count: "40" })],
    };
    world.stats["shop-stage"] = { day: [] };
    await world.start();
    const board = boardIn(boardOf(world.api, ""));
    expect(board.columns).toEqual([
      { id: "shop-prod", name: "shop-prod" },
      { id: "shop-stage", name: "shop-stage" },
    ]);
    expect(board.items).toHaveLength(1);
    const card = board.items[0];
    expect(card).toMatchObject({
      key: "shop-prod/G1",
      title: "KeyError: 'cart'",
      group: "shop-prod",
      sub: "checkout · cloud_run_revision",
      detail: "Error group · 12 in 24 h · last 5 min ago",
      tone: "critical",
      url: "https://console.cloud.google.com/errors/detail/G1?project=shop-prod",
      started: false,
    });
    expect(card?.sparks).toEqual([
      { period: "1h", counts: [6], total: 6 },
      { period: "24h", counts: [4, 8], total: 12 },
      { period: "7d", counts: [4, 8], total: 40 },
    ]);
    expect(board.actions?.map((each) => each.key)).toEqual(["setup:projects", "info:account"]);
    expect(board.actions?.[1]?.title).toContain("reader@example.com");
  });

  test("tone follows recency: a quiet old group is info, a recent one warning", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = {
      day: [
        stat("OLD", { lastSeenTime: "2026-10-11T02:00:00Z", message: "old one" }),
        stat("NEW", { lastSeenTime: "2026-10-11T10:00:00Z", message: "new one" }),
      ],
    };
    await world.start();
    const tones = Object.fromEntries(
      boardIn(boardOf(world.api, "")).items.map((item) => [item.title, item.tone]),
    );
    expect(tones).toEqual({ "old one": "info", "new one": "warning" });
  });

  test("resolved and muted groups are left out", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = {
      day: [
        stat("OPEN"),
        stat("DONE", { group: { groupId: "DONE", resolutionStatus: "RESOLVED" } }),
        stat("QUIET", { group: { groupId: "QUIET", resolutionStatus: "MUTED" } }),
      ],
    };
    await world.start();
    expect(boardIn(boardOf(world.api, "")).items.map((item) => item.key)).toEqual([
      "shop-prod/OPEN",
    ]);
  });

  test("the query filters over title, sub, project and group id", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = {
      day: [stat("G1"), stat("G2", { message: "ValueError: nope", service: "billing" })],
    };
    await world.start();
    const keys = (query: string) =>
      boardIn(boardOf(world.api, query)).items.map((item) => item.key);
    expect(keys("valueerror")).toEqual(["shop-prod/G2"]);
    expect(keys("billing")).toEqual(["shop-prod/G2"]);
    expect(keys("g1")).toEqual(["shop-prod/G1"]);
    expect(keys("shop-prod")).toHaveLength(2);
    expect(keys("nothing like it")).toEqual([]);
  });

  test("a project whose read failed shows one warning card that starts nothing", async () => {
    world = makeWorld({ chosen: ["shop-prod", "broken"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    world.stats["broken"] = () => serviceDisabled("clouderrorreporting.googleapis.com", "broken");
    await world.start();
    const board = boardIn(boardOf(world.api, ""));
    const inBroken = board.items.filter((item) => item.group === "broken");
    expect(inBroken).toHaveLength(1);
    expect(inBroken[0]?.key).toBe("failed:broken");
    expect(inBroken[0]?.tone).toBe("warning");
    expect(inBroken[0]?.title).toContain("is not enabled in project broken");
    const launch = await launchOf(world.api, "failed:broken", "", { again: false });
    expect(launch.prompt).toBe("");
    expect(launch.message).toBe(inBroken[0]?.title);
    expect(board.items.filter((item) => item.group === "shop-prod")).toHaveLength(1);
  });

  test("a column with no open groups has no cards", async () => {
    world = makeWorld({ chosen: ["shop-prod", "shop-stage"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    world.stats["shop-stage"] = { day: [] };
    await world.start();
    const board = boardIn(boardOf(world.api, ""));
    expect(board.columns.map((each) => each.id)).toContain("shop-stage");
    expect(board.items.filter((item) => item.group === "shop-stage")).toHaveLength(0);
  });
});
