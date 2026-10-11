import { afterEach, describe, expect, test } from "bun:test";
import { boardOf } from "../board";
import { startPoller } from "../poll";
import { MINUTE, makeWorld, stat, type World } from "./board-world";
import { rateLimited, serviceDisabled } from "./google-fake";

let world: World;
afterEach(() => world.cleanup());

describe("the poller", () => {
  test("reads each chosen project for the three periods, with the project passed on", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.start();
    const calls = world.groupStatsCalls();
    expect(calls).toHaveLength(3);
    expect(
      calls.some((url) => url.includes("PERIOD_1_HOUR") && url.includes("timedCountDuration=600s")),
    ).toBe(true);
    expect(
      calls.some((url) => url.includes("PERIOD_1_DAY") && url.includes("timedCountDuration=3600s")),
    ).toBe(true);
    expect(
      calls.some(
        (url) => url.includes("PERIOD_1_WEEK") && url.includes("timedCountDuration=86400s"),
      ),
    ).toBe(true);
    expect(
      calls.every((url) => url.includes("order=LAST_SEEN_DESC") && url.includes("pageSize=50")),
    ).toBe(true);
    expect(world.conn.options.every((each) => each?.project === "shop-prod")).toBe(true);
  });

  test("reads again on each timer tick, and boardOf never fetches", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.start();
    boardOf(world.api, "a");
    boardOf(world.api, "ab");
    expect(world.groupStatsCalls()).toHaveLength(3);
    await world.tick();
    expect(world.groupStatsCalls()).toHaveLength(6);
  });

  test("a new group lights the launcher; the first read and an unchanged read do not", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.start();
    expect(world.fake.flags.get("error")).toBeUndefined();
    await world.tick();
    expect(world.fake.flags.get("error")).toBeUndefined();

    world.stats["shop-prod"] = { day: [stat("G2"), stat("G1")] };
    await world.tick();
    expect(world.fake.flags.get("error")).toEqual({
      tone: "critical",
      hint: "1 new error group in shop-prod",
    });
  });

  test("opening the board clears the glow, once", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.start();
    world.stats["shop-prod"] = { day: [stat("G1"), stat("G2"), stat("G3")] };
    await world.tick();
    expect(world.fake.flags.get("error")?.hint).toBe("2 new error groups in shop-prod");
    boardOf(world.api, "");
    expect(world.fake.flags.get("error")).toBeNull();
    world.fake.flags.delete("error");
    boardOf(world.api, "x");
    expect(world.fake.flags.has("error")).toBe(false);
  });

  test("a rate-limited project waits out its retry-after, the others go on", async () => {
    world = makeWorld({ chosen: ["shop-prod", "shop-stage"] });
    world.stats["shop-prod"] = () => rateLimited(600);
    world.stats["shop-stage"] = { day: [stat("S1")] };
    await world.start();
    const prodCalls = () =>
      world.groupStatsCalls().filter((url) => url.includes("shop-prod")).length;
    const stageCalls = () =>
      world.groupStatsCalls().filter((url) => url.includes("shop-stage")).length;
    expect(prodCalls()).toBe(3);

    await world.tick(5 * MINUTE);
    expect(prodCalls()).toBe(3);
    expect(stageCalls()).toBe(6);

    await world.tick(5 * MINUTE);
    expect(prodCalls()).toBe(6);
  });

  test("a rate-limited read keeps what the board showed before", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.start();
    world.stats["shop-prod"] = () => rateLimited(30);
    await world.tick();
    const board = boardOf(world.api, "");
    expect(Array.isArray(board) ? [] : board.items.map((item) => item.key)).toEqual([
      "shop-prod/G1",
    ]);
  });

  test("a failed read does not drop the project's earlier groups from 'new' counting", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.start();
    world.stats["shop-prod"] = () =>
      serviceDisabled("clouderrorreporting.googleapis.com", "shop-prod");
    await world.tick();
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.tick();
    expect(world.fake.flags.get("error")).toBeUndefined();
  });

  test("nothing is read while the reader is not signed in for Cloud", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.conn.endpoint.revoke("google-1");
    await world.start();
    await world.tick();
    expect(world.conn.requests).toHaveLength(0);
  });

  test("the stop function clears the timer", async () => {
    world = makeWorld({ chosen: ["shop-prod"] });
    world.stats["shop-prod"] = { day: [stat("G1")] };
    await world.start();
    world.stop();
    await world.tick();
    expect(world.groupStatsCalls()).toHaveLength(3);
  });

  test("the default timer is a real interval that stop clears", () => {
    world = makeWorld({ chosen: [] });
    const stop = startPoller(world.api);
    stop();
  });
});
