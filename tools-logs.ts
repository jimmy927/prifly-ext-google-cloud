/** `gcloud_logs`: Cloud Logging `entries:list`, one line per entry. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gfetch } from "./google";
import { lastSegment, orSentence, type Ready, stringArg, type ToolSpec } from "./tools-common";

const ENTRIES = "https://logging.googleapis.com/v2/entries:list";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CHARS = 12_000;
const SHOWN_WHEN_LONG = 40;

type LogEntry = {
  timestamp?: string;
  severity?: string;
  trace?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  protoPayload?: { methodName?: string; status?: { message?: string } };
  resource?: { type?: string; labels?: Record<string, string> };
};

type EntriesPage = { entries?: LogEntry[]; nextPageToken?: string };

function limitOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function defaultFilter(now: number): string {
  const since = new Date(now - 60 * 60 * 1000).toISOString();
  return `severity>=ERROR AND timestamp>="${since}"`;
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

function jsonMessage(json: Record<string, unknown>): string {
  for (const key of ["message", "msg", "error"]) {
    const value = json[key];
    if (typeof value === "string") return firstLine(value);
  }
  return firstLine(JSON.stringify(json));
}

function payloadOf(entry: LogEntry): string {
  if (entry.textPayload !== undefined) return firstLine(entry.textPayload);
  if (entry.jsonPayload !== undefined) return jsonMessage(entry.jsonPayload);
  const proto = entry.protoPayload;
  if (proto === undefined) return "";
  return [proto.methodName, proto.status?.message].filter((part) => part).join(" ");
}

function resourceOf(entry: LogEntry): string {
  const { type = "", labels = {} } = entry.resource ?? {};
  const main = Object.entries(labels)
    .filter(([key]) => key !== "project_id")
    .map(([key, value]) => `${key}=${value}`);
  return main.length > 0 ? `${type}{${main.join(",")}}` : type;
}

function entryLine(entry: LogEntry): string {
  const trace = lastSegment(entry.trace);
  return [
    entry.timestamp ?? "?",
    entry.severity ?? "DEFAULT",
    resourceOf(entry),
    payloadOf(entry),
    trace === "" ? "" : `trace=${trace}`,
  ]
    .filter((part) => part !== "")
    .join(" | ");
}

/** The lines when they fit; else the first ones and where the rest went. */
function describeEntries(entries: LogEntry[], ready: Ready, now: number): string {
  const lines = entries.map(entryLine);
  const text = lines.join("\n");
  if (text.length <= MAX_CHARS) return text;
  const head = lines.slice(0, SHOWN_WHEN_LONG).join("\n");
  const cut = lines.length - SHOWN_WHEN_LONG;
  const scratchpad = ready.ctx.scratchpad;
  if (scratchpad === undefined) {
    return `${head}\n(${cut} more entries cut: the answer was too long and this session has no scratchpad. Narrow the filter or lower limit.)`;
  }
  mkdirSync(scratchpad, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const file = join(scratchpad, `gcloud-logs-${ready.project}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(entries, null, 2));
  return `${head}\n(${cut} more entries cut: all ${lines.length} are in ${file})`;
}

async function runLogs(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const now = Date.now();
  const filter = stringArg(args, "filter") ?? defaultFilter(now);
  const answer = orSentence(
    await gfetch<EntriesPage>(ready.connections, ready.connection, ENTRIES, {
      project: ready.project,
      body: {
        resourceNames: [`projects/${ready.project}`],
        filter,
        orderBy: "timestamp desc",
        pageSize: limitOf(args["limit"]),
      },
    }),
  );
  if ("sentence" in answer) return answer.sentence;
  const entries = answer.value.entries ?? [];
  if (entries.length === 0) return `No log entries in ${ready.project} match: ${filter}`;
  const more = answer.value.nextPageToken
    ? "\n(More entries match; raise limit or narrow the filter.)"
    : "";
  return `${describeEntries(entries, ready, now)}${more}`;
}

export const logsTool: ToolSpec = {
  name: "gcloud_logs",
  description:
    "Recent Cloud Logging entries of a Google Cloud project, newest first, one line each (time, severity, resource, message, trace). Default: errors of the last hour. Read-only.",
  perProject: true,
  properties: {
    filter: {
      type: "string",
      description:
        'A Cloud Logging query, e.g. resource.type="cloud_run_revision" AND severity>=WARNING. Default: severity>=ERROR in the last hour.',
    },
    limit: { type: "number", description: "Entries to return, 1-200. Default 50." },
  },
  run: runLogs,
};
