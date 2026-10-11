/**
 * The Error Reporting poller. It reads every chosen project's open error
 * groups (1 h, 24 h and 7 d) every `pollMinutes` minutes, first at once, and
 * keeps the answer in a module-level cache the board answers from: the
 * launcher asks for choices on every keystroke, so the board never fetches.
 *
 * A project that answered 429 is left alone until its `retryAfter` is over; a
 * reader who is not signed in for Cloud is not read for at all. A group that
 * was not in the project's previous successful read lights the launcher's
 * button, until the reader opens the board.
 */

import { PERIODS, readStats } from "./errors-api";
import { type ErrorGroup, groupsOf } from "./errors-group";
import { type Failure, type Result, sayFailure } from "./google";
import type { HostApi } from "./host";
import { standing } from "./scope";
import { pollMinutes, readChosen } from "./settings";

/** What the poller knows about one project. */
export type ProjectRead = { groups: ErrorGroup[]; failure: string | null };

/** The clock and the timer, replaceable so a test never sleeps. */
export type PollerEnv = {
  now: () => number;
  /** Runs `run` every `ms`; returns what stops it. */
  repeat: (run: () => void, ms: number) => () => void;
};

const REAL: PollerEnv = {
  now: () => Date.now(),
  repeat: (run, ms) => {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
};

type State = {
  api: HostApi;
  env: PollerEnv;
  reads: Map<string, ProjectRead>;
  /** The group ids of each project's last successful read. */
  seen: Map<string, Set<string>>;
  /** Not before this (ms) is a rate-limited project read again. */
  retryAt: Map<string, number>;
  running: Promise<void> | null;
  flagged: boolean;
};

let current: State | null = null;

/** The clock the board's "last 5 min ago" uses: the poller's, or the real one. */
export function nowMs(): number {
  return current === null ? Date.now() : current.env.now();
}

/** True once a project has been read (well or badly), so the board has something to show. */
export function hasRead(): boolean {
  return current !== null && current.reads.size > 0;
}

export function readOf(project: string): ProjectRead | undefined {
  return current?.reads.get(project);
}

export function groupOf(project: string, groupId: string): ErrorGroup | undefined {
  return readOf(project)?.groups.find((each) => each.groupId === groupId);
}

/** The reader opened the board: the launcher button stops glowing. */
export function clearFlag(api: HostApi): void {
  if (current === null || !current.flagged) return;
  current.flagged = false;
  api.flag("error", null);
}

/** Read now, e.g. for a project the reader just added. */
export function refreshNow(): Promise<void> {
  return current === null ? Promise.resolve() : round(current);
}

export function startPoller(api: HostApi, env: PollerEnv = REAL): () => void {
  const state: State = {
    api,
    env,
    reads: new Map(),
    seen: new Map(),
    retryAt: new Map(),
    running: null,
    flagged: false,
  };
  current = state;
  void round(state);
  const cancel = env.repeat(() => {
    void round(state);
  }, pollMinutes(api) * 60_000);
  return () => {
    cancel();
    if (current === state) current = null;
  };
}

function round(state: State): Promise<void> {
  if (state.running !== null) return state.running;
  const running = readAll(state)
    .catch((error: unknown) => state.api.log("poll-failed", { message: String(error) }))
    .finally(() => {
      state.running = null;
    });
  state.running = running;
  return running;
}

async function readAll(state: State): Promise<void> {
  const { api } = state;
  const where = standing(api.connections);
  if (where.kind !== "ok" || api.connections === undefined) return;
  const connection = where.connection.id;
  const due = readChosen(api.folder).projects.filter(
    (project) => state.env.now() >= (state.retryAt.get(project) ?? 0),
  );
  const fresh = await Promise.all(
    due.map(async (project) => {
      const answer = await readProject(api, connection, project);
      return { project, answer };
    }),
  );
  if (current !== state) return;
  const added: string[] = [];
  let newGroups = 0;
  for (const { project, answer } of fresh) {
    const count = take(state, project, answer);
    if (count > 0) added.push(project);
    newGroups += count;
  }
  if (newGroups > 0) raise(state, newGroups, added);
}

/** Keep one project's answer; returns how many groups in it are new. */
function take(state: State, project: string, answer: Result<ErrorGroup[]>): number {
  if ("ok" in answer) {
    state.reads.set(project, { groups: answer.ok, failure: null });
    state.retryAt.delete(project);
    const before = state.seen.get(project);
    state.seen.set(project, new Set(answer.ok.map((each) => each.groupId)));
    return before === undefined ? 0 : answer.ok.filter((each) => !before.has(each.groupId)).length;
  }
  if ("rateLimited" in answer) {
    state.retryAt.set(project, state.env.now() + answer.rateLimited.retryAfter * 1000);
    // What was read before stays on the board; a first read has nothing to keep.
    if (state.reads.has(project)) return 0;
  }
  // A failed read keeps the groups of the last good one, beside the failure.
  state.reads.set(project, {
    groups: state.reads.get(project)?.groups ?? [],
    failure: sayFailure(answer),
  });
  return 0;
}

function raise(state: State, count: number, projects: string[]): void {
  const noun = count === 1 ? "group" : "groups";
  state.api.flag("error", {
    tone: "critical",
    hint: `${count} new error ${noun} in ${projects.join(", ")}`,
  });
  state.flagged = true;
}

/** Failures of the 1 h and 7 d reads that mean the next read should wait or the reader act. */
function mustStop(answer: Result<unknown>): answer is Failure {
  return "rateLimited" in answer || "needsSignIn" in answer;
}

/** One project's open groups: the 24 h read gives the groups, the others the sparks. */
export async function readProject(
  api: HostApi,
  connection: string,
  project: string,
): Promise<Result<ErrorGroup[]>> {
  const { connections } = api;
  if (connections === undefined) return { failed: { status: 0, message: "No connections." } };
  const [hour, day, week] = await Promise.all(
    PERIODS.map((period) => readStats(connections, connection, project, period)),
  );
  if (hour === undefined || day === undefined || week === undefined) {
    return { failed: { status: 0, message: "No answer." } };
  }
  if (!("ok" in day)) return day;
  for (const other of [hour, week]) if (mustStop(other)) return other;
  return {
    ok: groupsOf(project, day.ok, "ok" in hour ? hour.ok : null, "ok" in week ? week.ok : null),
  };
}
