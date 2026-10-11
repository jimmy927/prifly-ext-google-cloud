/**
 * A fake Google with open error groups, a fake clock and a temp folder, for
 * the board, poller and launch tests.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEntry, RawEvent, RawStat } from "../errors-api";
import { forgetProjects } from "../errors-projects";
import type { HostApi } from "../host";
import type { PollerEnv } from "../poll";
import { settled, startPoller } from "../poll";
import { type FakeApi, type FakeConnections, fakeApi, fakeConnections } from "./fake-api";
import { CLOUD_ACCOUNT, fakeGoogle, json, type Route } from "./google-fake";

export const NOW = Date.parse("2026-10-11T12:00:00Z");
export const MINUTE = 60_000;

/** What the fake answers for one project's groupStats, by period; or a whole response. */
export type Stats =
  | { day: RawStat[]; hour?: RawStat[]; week?: RawStat[] }
  | { pages: RawStat[][] }
  | (() => Response);

export type World = {
  folder: string;
  fake: FakeApi;
  conn: FakeConnections;
  api: HostApi;
  stats: Record<string, Stats>;
  events: Record<string, RawEvent[] | (() => Response)>;
  entries: LogEntry[] | (() => Response);
  logBodies: { resourceNames: string[]; filter: string; orderBy: string; pageSize: number }[];
  now: number;
  /** Time passes; the poller's timer fires once. */
  tick: (ms?: number) => Promise<void>;
  /** Start the poller on the fake clock and wait for its first read. */
  start: () => Promise<void>;
  stop: () => void;
  groupStatsCalls: () => string[];
  cleanup: () => void;
};

export function stat(
  groupId: string,
  over: Partial<RawStat> & { message?: string; service?: string } = {},
): RawStat {
  const { message, service, ...rest } = over;
  return {
    group: { groupId, name: `projects/p/groups/${groupId}`, resolutionStatus: "OPEN" },
    count: "12",
    affectedUsersCount: "3",
    timedCounts: [
      { count: "4", startTime: "2026-10-11T10:00:00Z", endTime: "2026-10-11T11:00:00Z" },
      { count: "8", startTime: "2026-10-11T11:00:00Z", endTime: "2026-10-11T12:00:00Z" },
    ],
    firstSeenTime: "2026-10-09T08:00:00Z",
    lastSeenTime: "2026-10-11T11:55:00Z",
    affectedServices: [{ service: service ?? "checkout" }],
    representative: {
      eventTime: "2026-10-11T11:55:00Z",
      message: message ?? "KeyError: 'cart'\n  File \"app.py\", line 3, in view",
      serviceContext: {
        service: service ?? "checkout",
        version: "v7",
        resourceType: "cloud_run_revision",
      },
    },
    ...rest,
  };
}

function periodOf(url: string): "hour" | "day" | "week" {
  if (url.includes("PERIOD_1_HOUR")) return "hour";
  return url.includes("PERIOD_1_WEEK") ? "week" : "day";
}

/** One page of a paged groupStats answer; the token is `p<index>`. */
function pageOf(pages: RawStat[][], url: string): Response {
  const token = new URL(url).searchParams.get("pageToken");
  const index = token === null ? 0 : Number(token.slice(1));
  return json({
    errorGroupStats: pages[index] ?? [],
    ...(index + 1 < pages.length ? { nextPageToken: `p${index + 1}` } : {}),
  });
}

export function makeWorld(
  options: { accounts?: (typeof CLOUD_ACCOUNT)[]; projects?: string[]; chosen?: string[] } = {},
): World {
  const folder = mkdtempSync(join(tmpdir(), "gcloud-board-"));
  // The routes, the clock and the tests all read and edit this one object.
  const built = {
    folder,
    stats: {},
    events: {},
    entries: [],
    logBodies: [],
    now: NOW,
  } as unknown as World;
  const routes: Route[] = [
    {
      url: /projects\/([^/]+)\/groupStats\?(.*)/,
      answer: (request, match) => {
        const answer = built.stats[match[1] ?? ""];
        if (answer === undefined) return json({});
        if (typeof answer === "function") return answer();
        if ("pages" in answer) return pageOf(answer.pages, request.url);
        const period = periodOf(request.url);
        return json({ errorGroupStats: answer[period] ?? (period === "day" ? answer.day : []) });
      },
    },
    {
      url: /projects\/([^/]+)\/events\?.*groupId=([^&]+)/,
      answer: (_request, match) => {
        const answer = built.events[match[1] ?? ""];
        return typeof answer === "function" ? answer() : json({ errorEvents: answer ?? [] });
      },
    },
    {
      method: "POST",
      url: /entries:list/,
      answer: async (request) => {
        built.logBodies.push((await request.json()) as World["logBodies"][number]);
        return typeof built.entries === "function"
          ? built.entries()
          : json({ entries: built.entries });
      },
    },
    {
      url: /projects:search/,
      answer: () =>
        json({
          projects: (options.projects ?? ["shop-prod", "shop-stage"]).map((id) => ({
            projectId: id,
            displayName: `Name of ${id}`,
            state: "ACTIVE",
          })),
        }),
    },
  ];
  const conn = fakeConnections({
    accounts: options.accounts ?? [{ ...CLOUD_ACCOUNT }],
    provider: fakeGoogle(routes),
  });
  const fake = fakeApi({ connections: conn.connections, folder });
  const api = fake.api as HostApi;
  if (options.chosen !== undefined) {
    writeFileSync(
      join(folder, "state.json"),
      JSON.stringify({ projects: options.chosen, defaultProject: options.chosen[0] ?? "" }),
    );
  }
  let fire: () => void = () => undefined;
  let stopPoller: () => void = () => undefined;
  const env: PollerEnv = {
    now: () => built.now,
    repeat: (run) => {
      fire = run;
      return () => {
        fire = () => undefined;
      };
    },
  };
  return Object.assign(built, {
    fake,
    conn,
    api,
    tick: async (ms = 5 * MINUTE) => {
      built.now += ms;
      fire();
      await settled();
    },
    start: async () => {
      stopPoller = startPoller(api, env);
      await settled();
    },
    stop: () => {
      stopPoller();
      forgetProjects();
    },
    groupStatsCalls: () =>
      conn.requests.map((each) => each.url).filter((url) => url.includes("groupStats")),
    cleanup: () => {
      built.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  });
}
