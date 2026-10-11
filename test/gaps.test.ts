import { afterEach, describe, expect, test } from "bun:test";
import type { LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import { boardOf, setChoosing } from "../board";
import { projectsRead } from "../errors-projects";
import { launchOf } from "../launch";
import { refreshNow } from "../poll";
import { makeWorld, stat, type World } from "./board-world";

let world: World;
afterEach(() => {
  setChoosing(false);
  world.cleanup();
});

function rowsIn(found: LaunchBoard | LaunchChoice[]): LaunchChoice[] {
  if (!Array.isArray(found)) throw new Error("Expected setup rows, got a board");
  return found;
}

function boardIn(found: LaunchBoard | LaunchChoice[]): LaunchBoard {
  if (Array.isArray(found)) throw new Error(`Expected a board, got ${JSON.stringify(found)}`);
  return found;
}

describe("a project list that fails", () => {
  test("a rejected read becomes the failure sentence and a Try again row, and is logged", async () => {
    world = makeWorld({});
    world.conn.connections.fetch = async () => {
      throw new Error("socket closed");
    };
    expect(rowsIn(boardOf(world.api, ""))[0]?.key).toBe("setup:reading");
    await projectsRead();
    const rows = rowsIn(boardOf(world.api, ""));
    expect(rows.map((row) => row.key)).toEqual(["setup:failed", "setup:reload"]);
    expect(rows[0]?.title).toContain("socket closed");
    expect(rows[1]?.title).toBe("Try again");
    expect(world.fake.logs.some((log) => log.event === "projects-failed")).toBe(true);
  });

  test("a failed answer shows its sentence, and Try again reads the list again", async () => {
    world = makeWorld({});
    const fetchOk = world.conn.connections.fetch;
    world.conn.connections.fetch = async () => new Response("boom", { status: 500 });
    boardOf(world.api, "");
    await projectsRead();
    const rows = rowsIn(boardOf(world.api, ""));
    expect(rows[0]?.title).toContain("500");
    world.conn.connections.fetch = fetchOk;
    await launchOf(world.api, "setup:reload", "", { again: false });
    boardOf(world.api, "");
    await projectsRead();
    const after = rowsIn(boardOf(world.api, ""));
    expect(after.map((row) => row.key)).toEqual(["setup:add:shop-prod", "setup:add:shop-stage"]);
  });
});

describe("chips after a restart", () => {
  test("activate shows the chip of every launched session still in the sidebar", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    await Bun.write(
      `${world.folder}/launched.json`,
      JSON.stringify({ "shop-prod/G1": "sess-1", "shop-prod/G2": "sess-gone" }),
    );
    world.api.sessions = () => [{ id: "sess-1", title: "t", cwd: "/x", state: "idle" }];
    const { activate } = await import("../index");
    const stop = activate(world.api);
    const last = world.fake.shown.at(-1);
    expect(Object.keys(last?.bySession ?? {})).toEqual(["sess-1"]);
    expect(last?.bySession["sess-1"]?.[0]).toMatchObject({
      key: "error:shop-prod/G1",
      label: "Error group · shop-prod",
    });
    stop();
  });
});

describe("a project added while a round is in flight", () => {
  test("is read as soon as that round ends, and its column says it is being read", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    world.stats["shop-stage"] = { day: [stat("S1")] };
    const started = world.start();
    await launchOf(world.api, "setup:add:shop-stage", "", { again: false });
    const midway = world.groupStatsCalls().filter((url) => url.includes("shop-stage"));
    expect(midway).toHaveLength(0);
    await started;
    const calls = world.groupStatsCalls().filter((url) => url.includes("shop-stage"));
    expect(calls).toHaveLength(3);
    const items = boardIn(boardOf(world.api, "")).items;
    expect(items.map((item) => item.key)).toEqual(["shop-prod/G1", "shop-stage/S1"]);
  });

  test("until its first read lands the column holds a muted reading item", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.start();
    await launchOf(world.api, "setup:add:shop-stage", "", { again: false });
    const items = boardIn(boardOf(world.api, "")).items;
    expect(items.find((item) => item.group === "shop-stage")).toEqual({
      key: "reading:shop-stage",
      title: "Reading Error Reporting…",
      group: "shop-stage",
      tone: "muted",
    });
    await refreshNow();
    expect(
      boardIn(boardOf(world.api, "")).items.some((item) => item.key.startsWith("reading:")),
    ).toBe(false);
  });
});

describe("paged group stats", () => {
  const pageOfGroups = (from: number): ReturnType<typeof stat>[] => [
    stat(`G${from}`),
    stat(`G${from + 1}`),
  ];

  test("follows nextPageToken until the last page", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { pages: [pageOfGroups(1), pageOfGroups(3), pageOfGroups(5)] };
    await world.start();
    expect(boardIn(boardOf(world.api, "")).items).toHaveLength(6);
    const day = world.groupStatsCalls().filter((url) => url.includes("PERIOD_1_DAY"));
    expect(day).toHaveLength(3);
    expect(day[1]).toContain("pageToken=p1");
  });

  test("stops after four pages", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = {
      pages: [1, 3, 5, 7, 9, 11].map((from) => pageOfGroups(from)),
    };
    await world.start();
    expect(boardIn(boardOf(world.api, "")).items).toHaveLength(8);
    const day = world.groupStatsCalls().filter((url) => url.includes("PERIOD_1_DAY"));
    expect(day).toHaveLength(4);
  });
});
