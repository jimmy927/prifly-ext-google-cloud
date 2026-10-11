/**
 * The launcher `error`'s board: one column per chosen project, one card per
 * open error group, answered from the poller's cache. Until the reader is set
 * up it is a list of setup rows instead, and a click on one fixes it.
 */

import type { LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import { apisOf } from "./errors-apis";
import { ago, consoleUrl, countIn, type ErrorGroup, sparksOf, toneOf } from "./errors-group";
import { readLaunched } from "./errors-launched";
import { projectRows } from "./errors-projects";
import type { HostApi } from "./host";
import { clearFlag, hasRead, nowMs, readOf } from "./poll";
import { type Standing, standing } from "./scope";
import { readChosen } from "./settings";

/** The reader asked to choose projects: the next lists are add/remove rows. */
let choosing = false;

export function setChoosing(on: boolean): void {
  choosing = on;
}

function setupRows(state: Standing): LaunchChoice[] {
  switch (state.kind) {
    case "no-api":
      return [
        {
          key: "setup:none",
          title: "This prifly has no Google connections: update prifly",
          tone: "muted",
        },
      ];
    case "no-account":
    case "no-scope": {
      const who = state.kind === "no-scope" ? state.connection.account : "your Google account";
      return [{ key: "setup:allow", title: `Allow Google Cloud for ${who}`, tone: "info" }];
    }
    case "needs-sign-in":
      return [
        {
          key: "setup:allow",
          title: `Sign in again as ${state.connection.account}`,
          tone: "warning",
        },
      ];
    case "ok":
      return [];
  }
}

function cardOf(group: ErrorGroup, started: boolean, now: number): LaunchChoice {
  const sub = [group.service, group.resourceType].filter((each) => each !== "").join(" · ");
  return {
    key: `${group.project}/${group.groupId}`,
    title: group.title,
    group: group.project,
    ...(sub === "" ? {} : { sub }),
    detail: `Error group · ${countIn(group, "24h")} in 24 h · last ${ago(group.lastSeen, now)} ago`,
    sparks: sparksOf(group),
    tone: toneOf(group, now),
    url: consoleUrl(group.project, group.groupId),
    started,
  };
}

function matches(item: LaunchChoice, query: string): boolean {
  if (query === "") return true;
  const key = item.key.toLowerCase();
  return [item.title, item.sub ?? "", item.group ?? "", key].some((text) =>
    text.toLowerCase().includes(query),
  );
}

/** The row for the APIs of one project that are off, or that could not be checked; none when all are on. */
function apisRow(api: HostApi, connection: string, project: string): LaunchChoice[] {
  const found = apisOf(api, connection, project);
  if (found === null) {
    return [{ key: `apis:${project}`, title: "Checking the APIs…", group: project, tone: "muted" }];
  }
  if ("failure" in found) {
    return [{ key: `apis:${project}`, title: found.failure, group: project, tone: "warning" }];
  }
  const [first] = found;
  if (first === undefined) return [];
  return [
    {
      key: `apis:${project}`,
      title: `Not enabled: ${found.map((each) => each.title).join(", ")}`,
      group: project,
      detail: "Switch them on to read this project",
      tone: "warning",
      url: first.enableUrl,
    },
  ];
}

function itemsOf(api: HostApi, connection: string, projects: string[]): LaunchChoice[] {
  const now = nowMs();
  const launched = readLaunched(api.folder);
  const items: LaunchChoice[] = [];
  for (const project of projects) {
    items.push(...apisRow(api, connection, project));
    const read = readOf(project);
    if (read === undefined) {
      items.push({
        key: `reading:${project}`,
        title: "Reading Error Reporting…",
        group: project,
        tone: "muted",
      });
      continue;
    }
    if (read.failure !== null) {
      items.push({
        key: `failed:${project}`,
        title: read.failure,
        group: project,
        tone: "warning",
      });
    }
    for (const group of read.groups) {
      const key = `${group.project}/${group.groupId}`;
      items.push(cardOf(group, key in launched, now));
    }
  }
  return items;
}

export function boardOf(api: HostApi, query: string): LaunchBoard | LaunchChoice[] {
  const where = standing(api.connections);
  if (where.kind !== "ok") return setupRows(where);
  const wanted = query.trim().toLowerCase();
  const { projects, defaultProject } = readChosen(api.folder);
  if (projects.length === 0 || choosing) {
    return projectRows(api, where.connection.id, projects).filter((row) => matches(row, wanted));
  }
  clearFlag(api);
  if (!hasRead()) return [{ key: "loading", title: "Reading Error Reporting…", tone: "muted" }];
  return {
    columns: projects.map((project) => ({ id: project, name: project })),
    items: itemsOf(api, where.connection.id, projects).filter((item) => matches(item, wanted)),
    actions: [
      { key: "setup:projects", title: "Choose projects…" },
      {
        key: "info:account",
        title:
          defaultProject === ""
            ? `Reading as ${where.connection.account}`
            : `Reading as ${where.connection.account} · default project ${defaultProject}`,
        tone: "muted",
      },
    ],
  };
}
