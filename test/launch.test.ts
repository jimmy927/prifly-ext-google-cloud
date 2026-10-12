import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boardOf } from "../board";
import type { LogEntry, RawEvent } from "../errors-api";
import { launchedOf, launchOf } from "../launch";
import { makeWorld, stat, type World } from "./board-world";
import { permissionDenied, serviceDisabled } from "./google-fake";

let world: World;
afterEach(() => world.cleanup());

const STACK = `KeyError: 'cart'
  File "app.py", line 3, in view
    return session["cart"]`;

const EVENTS: RawEvent[] = [
  {
    eventTime: "2026-10-11T11:40:00Z",
    serviceContext: { service: "checkout", version: "v7", resourceType: "cloud_run_revision" },
    message: "KeyError: 'older'",
  },
  {
    eventTime: "2026-10-11T11:55:00Z",
    serviceContext: { service: "checkout", version: "v7", resourceType: "cloud_run_revision" },
    message: STACK,
    context: {
      httpRequest: {
        method: "POST",
        url: "https://shop.example.com/cart",
        responseStatusCode: 500,
      },
      reportLocation: { filePath: "app.py", lineNumber: 3, functionName: "view" },
    },
  },
];

const ENTRIES: LogEntry[] = [
  { timestamp: "2026-10-11T11:54:30.100Z", severity: "WARNING", textPayload: "slow cart lookup" },
  {
    timestamp: "2026-10-11T11:55:00.250Z",
    severity: "ERROR",
    jsonPayload: { message: "session store unreachable" },
  },
];

async function ready(): Promise<void> {
  world = makeWorld({ chosen: ["shop-prod"] });
  world.stats["shop-prod"] = { day: [stat("G1")] };
  world.events["shop-prod"] = EVENTS;
  world.entries = ENTRIES;
  await world.start();
}

describe("launching an error group", () => {
  test("writes events.json and logs.json and tells the session about them", async () => {
    await ready();
    const launch = await launchOf(world.api, "shop-prod/G1", "", { again: false });

    const dir = join(world.folder, "issues", "shop-prod", "G1");
    expect(JSON.parse(readFileSync(join(dir, "events.json"), "utf8"))).toEqual(EVENTS);
    expect(JSON.parse(readFileSync(join(dir, "logs.json"), "utf8"))).toEqual(ENTRIES);

    const prompt = launch.prompt;
    expect(prompt).toContain("# KeyError: 'cart'");
    expect(prompt).toContain("Project: shop-prod");
    expect(prompt).toContain("Service: checkout (version v7)");
    expect(prompt).toContain("Resource type: cloud_run_revision");
    expect(prompt).toContain("12 in 24 h");
    expect(prompt).toContain("3 affected users");
    expect(prompt).toContain("First seen 2026-10-09T08:00:00Z");
    expect(prompt).toContain("https://console.cloud.google.com/errors/detail/G1?project=shop-prod");
    expect(prompt).toContain(STACK);
    expect(prompt).not.toContain("KeyError: 'older'");
    expect(prompt).toContain("POST https://shop.example.com/cart 500");
    expect(prompt).toContain("11:54:30.100 WARNING slow cart lookup");
    expect(prompt).toContain("11:55:00.250 ERROR session store unreachable");
    expect(prompt).toContain(join(dir, "events.json"));
    expect(prompt).toContain(join(dir, "logs.json"));
    expect(prompt).toContain("gcloud_logs");
    expect(prompt).toContain("gcloud_services");
    expect(prompt).toContain("gcloud_instances");
    expect(prompt).toContain("do not change anything in Google Cloud");
    expect(launch.name).toBe("checkout-keyerror-cart");
  });

  test("asks for the logs two minutes around the newest event, in that service", async () => {
    await ready();
    await launchOf(world.api, "shop-prod/G1", "", { again: false });
    const body = world.logBodies[0];
    expect(body?.resourceNames).toEqual(["projects/shop-prod"]);
    expect(body?.orderBy).toBe("timestamp asc");
    expect(body?.pageSize).toBe(100);
    expect(body?.filter).toContain("severity>=WARNING");
    expect(body?.filter).toContain('timestamp>="2026-10-11T11:53:00.000Z"');
    expect(body?.filter).toContain('timestamp<="2026-10-11T11:57:00.000Z"');
    expect(body?.filter).toContain(
      '(resource.labels.service_name="checkout" OR resource.labels.module_id="checkout" OR resource.labels.function_name="checkout")',
    );
  });

  test("shows at most 60 log lines in the prompt, the whole set in the file", async () => {
    await ready();
    world.entries = Array.from({ length: 90 }, (_, index) => ({
      timestamp: `2026-10-11T11:55:${String(index % 60).padStart(2, "0")}.000Z`,
      severity: "ERROR",
      textPayload: `line ${index}`,
    }));
    const launch = await launchOf(world.api, "shop-prod/G1", "", { again: false });
    expect((launch.prompt.match(/ ERROR line \d+/g) ?? []).length).toBe(60);
    const saved = JSON.parse(
      readFileSync(join(world.folder, "issues", "shop-prod", "G1", "logs.json"), "utf8"),
    );
    expect(saved).toHaveLength(90);
  });

  test("a failed events read is a message, not a prompt", async () => {
    await ready();
    world.events["shop-prod"] = () => permissionDenied("clouderrorreporting.events.list");
    const launch = await launchOf(world.api, "shop-prod/G1", "", { again: false });
    expect(launch.prompt).toBe("");
    expect(launch.message).toContain("Permission denied");
    expect(launch.message).toContain("clouderrorreporting.events.list");
    expect(existsSync(join(world.folder, "issues", "shop-prod", "G1", "events.json"))).toBe(false);
  });

  test("logs that cannot be read are said in the prompt, not hidden", async () => {
    await ready();
    world.entries = () => serviceDisabled("logging.googleapis.com", "shop-prod");
    const launch = await launchOf(world.api, "shop-prod/G1", "", { again: false });
    expect(launch.prompt).toContain(STACK);
    expect(launch.prompt).toContain("Could not be read");
    expect(launch.prompt).toContain("logging.googleapis.com");
  });

  test("a reader who is not signed in gets the reason as the message", async () => {
    await ready();
    world.conn.endpoint.revoke("google-1");
    const launch = await launchOf(world.api, "shop-prod/G1", "", { again: false });
    expect(launch.prompt).toBe("");
    expect(launch.message).toContain("Needs sign-in");
  });
});

describe("launched sessions", () => {
  test("launched.json keeps card -> session, and the card shows started", async () => {
    await ready();
    launchedOf(world.api, "shop-prod/G1", "sess-1");
    const saved = JSON.parse(readFileSync(join(world.folder, "launched.json"), "utf8"));
    expect(saved).toEqual({ "shop-prod/G1": "sess-1" });
    const board = boardOf(world.api, "");
    expect(Array.isArray(board) ? [] : board.items.map((item) => item.started)).toEqual([true]);
  });

  test("a chip for every launched session still in the sidebar", async () => {
    await ready();
    world.api.sessions = () => [{ id: "sess-1", title: "t", cwd: "/x", state: "idle" }];
    launchedOf(world.api, "shop-prod/G0", "sess-gone");
    launchedOf(world.api, "shop-prod/G1", "sess-1");
    const last = world.fake.shown.at(-1);
    expect(Object.keys(last?.bySession ?? {})).toEqual(["sess-1"]);
    expect(last?.statusBar).toEqual([]);
    expect(last?.bySession["sess-1"]).toEqual([
      {
        key: "error:shop-prod/G1",
        icon: "google-cloud",
        label: "Error group · shop-prod",
        tone: "info",
        details: ["KeyError: 'cart'"],
        url: "https://console.cloud.google.com/errors/detail/G1?project=shop-prod",
      },
    ]);
  });

  test("a launched.json that is not JSON counts as nothing launched", async () => {
    await ready();
    await Bun.write(join(world.folder, "launched.json"), "{ nope");
    launchedOf(world.api, "shop-prod/G1", "sess-1");
    expect(JSON.parse(readFileSync(join(world.folder, "launched.json"), "utf8"))).toEqual({
      "shop-prod/G1": "sess-1",
    });
  });
});
