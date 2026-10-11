/**
 * What a picked row of the error board starts: a session for an error group,
 * or — for a setup row — the setup itself, answered with an empty prompt and
 * a message so the chooser stays open and lists again.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Launch } from "@prifly/extension-api";
import { setChoosing } from "./board";
import { type RawEvent, readEvents, readLogs } from "./errors-api";
import type { ErrorGroup } from "./errors-group";
import { recordLaunch, splitKey } from "./errors-launched";
import { forgetProjects, projectsRead } from "./errors-projects";
import { errorPrompt } from "./errors-prompt";
import { sayFailure } from "./google";
import type { HostApi } from "./host";
import { groupOf, nowMs, readOf, readProject, refreshNow } from "./poll";
import { allowCloud, sayStanding, standing } from "./scope";
import { readChosen, writeChosen } from "./settings";

const NOTHING_HERE = (message: string): Launch => ({ prompt: "", message });

export async function launchOf(
  api: HostApi,
  key: string,
  _input: string,
  _how: { again: boolean },
): Promise<Launch> {
  if (key.startsWith("setup:")) return await setupOf(api, key);
  if (key.startsWith("reading:")) return NOTHING_HERE("Still reading that project.");
  if (key.startsWith("failed:")) {
    return NOTHING_HERE(readOf(key.slice("failed:".length))?.failure ?? "That read failed.");
  }
  const parts = splitKey(key);
  if (parts === null) return { prompt: "" };
  return await launchGroup(api, parts.project, parts.groupId);
}

export function launchedOf(api: HostApi, key: string, sessionId: string): void {
  recordLaunch(api, key, sessionId);
}

async function setupOf(api: HostApi, key: string): Promise<Launch> {
  if (key === "setup:allow") return await allow(api);
  if (key === "setup:projects") {
    setChoosing(true);
    return NOTHING_HERE("Pick the projects the board shows.");
  }
  if (key === "setup:done") {
    setChoosing(false);
    return NOTHING_HERE("Back on the board.");
  }
  if (key === "setup:reading") {
    await projectsRead();
    return NOTHING_HERE("Your projects are listed.");
  }
  if (key === "setup:failed") return NOTHING_HERE("Pick Try again to read your projects again.");
  if (key === "setup:reload") {
    forgetProjects();
    return NOTHING_HERE("Reading your projects again…");
  }
  const add = key.startsWith("setup:add:");
  const remove = key.startsWith("setup:remove:");
  if (!add && !remove) return { prompt: "" };
  return changeProject(api, key.slice((add ? "setup:add:" : "setup:remove:").length), add);
}

async function allow(api: HostApi): Promise<Launch> {
  const answer = await allowCloud(api.connections);
  if (!answer.ok) return NOTHING_HERE(answer.message);
  void refreshNow();
  return NOTHING_HERE(`Signed in as ${answer.account}`);
}

function changeProject(api: HostApi, project: string, add: boolean): Launch {
  const before = readChosen(api.folder);
  const projects = add
    ? [...new Set([...before.projects, project])]
    : before.projects.filter((each) => each !== project);
  const defaultProject = projects.includes(before.defaultProject)
    ? before.defaultProject
    : (projects[0] ?? "");
  writeChosen(api.folder, { projects, defaultProject });
  if (add) void refreshNow();
  return NOTHING_HERE(add ? `Showing ${project} on the board.` : `${project} is off the board.`);
}

function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, "_");
}

function slugOf(group: ErrorGroup): string {
  const slug = group.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const service = safe(group.service).toLowerCase();
  return [service, slug].filter((part) => part !== "").join("-") || "error-group";
}

/** The group from the poller's cache, or read now when the poller has not reached it. */
async function groupFor(
  api: HostApi,
  connection: string,
  project: string,
  groupId: string,
): Promise<ErrorGroup | { failure: string }> {
  const cached = groupOf(project, groupId);
  if (cached !== undefined) return cached;
  const read = await readProject(api, connection, project);
  if (!("ok" in read)) return { failure: sayFailure(read) };
  const found = read.ok.find((each) => each.groupId === groupId);
  return found ?? { failure: `Error group ${groupId} is no longer open in ${project}.` };
}

function newest(events: RawEvent[]): RawEvent | null {
  const sorted = [...events].sort((a, b) => (b.eventTime ?? "").localeCompare(a.eventTime ?? ""));
  return sorted[0] ?? null;
}

async function launchGroup(api: HostApi, project: string, groupId: string): Promise<Launch> {
  const where = standing(api.connections);
  const blocked = sayStanding(where);
  if (where.kind !== "ok" || api.connections === undefined) {
    return NOTHING_HERE(blocked ?? "Google Cloud is not set up.");
  }
  const connection = where.connection.id;
  const group = await groupFor(api, connection, project, groupId);
  if ("failure" in group) return NOTHING_HERE(group.failure);
  const events = await readEvents(api.connections, connection, project, groupId);
  if (!("ok" in events)) return NOTHING_HERE(sayFailure(events));
  const event = newest(events.ok);
  const service = event?.serviceContext?.service ?? group.service;
  const logs = await readLogs(
    api.connections,
    connection,
    project,
    event?.eventTime ?? group.lastSeen,
    service,
  );
  const folder = join(api.folder, "issues", safe(project), safe(groupId));
  const files = { events: join(folder, "events.json"), logs: join(folder, "logs.json") };
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(files.events, `${JSON.stringify(events.ok, null, 2)}\n`, { mode: 0o600 });
    const saved = "ok" in logs ? logs.ok : { error: sayFailure(logs) };
    writeFileSync(files.logs, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return NOTHING_HERE(`Could not save the event files: ${String(error)}`);
  }
  return {
    prompt: errorPrompt({
      group,
      event,
      logs: "ok" in logs ? logs.ok : null,
      logsFailure: "ok" in logs ? "" : sayFailure(logs),
      files,
      now: nowMs(),
    }),
    name: slugOf(group),
  };
}
