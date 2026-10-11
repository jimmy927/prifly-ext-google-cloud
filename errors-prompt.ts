/**
 * An error group as the first thing a session is told: what broke and how
 * often, the newest event's whole stack, the request it happened in and the
 * log lines around it. The full JSON is saved beside it and named, so the
 * trimmed text is a starting point and not the limit.
 */

import type { LogEntry, RawEvent } from "./errors-api";
import { ago, consoleUrl, countIn, type ErrorGroup } from "./errors-group";

export const MAX_LOG_LINES = 60;
const LINE_MAX = 300;

export type PromptParts = {
  group: ErrorGroup;
  /** The newest event, or null when none could be read. */
  event: RawEvent | null;
  /** The log lines around it; null when they could not be read, with why. */
  logs: LogEntry[] | null;
  logsFailure: string;
  files: { events: string; logs: string };
  now: number;
};

function fenced(text: string): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}\n${text.trimEnd()}\n${fence}`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat;
}

function payloadOf(entry: LogEntry): string {
  if (entry.textPayload !== undefined) return entry.textPayload;
  for (const payload of [entry.jsonPayload, entry.protoPayload]) {
    if (payload === undefined) continue;
    const said = payload["message"] ?? payload["msg"];
    return typeof said === "string" ? said : JSON.stringify(payload);
  }
  return "";
}

/** `10:00:01.250 ERROR text`, one line. */
export function logLine(entry: LogEntry): string {
  const time = (entry.timestamp ?? "").replace(/^.*T/, "").replace(/Z$/, "").slice(0, 12);
  return oneLine(`${time} ${entry.severity ?? "DEFAULT"} ${payloadOf(entry)}`);
}

/** At most `MAX_LOG_LINES` entries, those nearest the event, in time order. */
export function nearest(entries: LogEntry[], eventTime: string): LogEntry[] {
  if (entries.length <= MAX_LOG_LINES) return entries;
  const at = new Date(eventTime).getTime();
  const distance = (entry: LogEntry): number =>
    Math.abs(new Date(entry.timestamp ?? "").getTime() - at) || 0;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => distance(a.entry) - distance(b.entry))
    .slice(0, MAX_LOG_LINES)
    .sort((a, b) => a.index - b.index)
    .map((each) => each.entry);
}

function facts(group: ErrorGroup, now: number): string[] {
  const lines = [
    `Project: ${group.project}`,
    `Service: ${group.service || "unknown"}${group.version === "" ? "" : ` (version ${group.version})`}`,
    `Resource type: ${group.resourceType || "unknown"}`,
    `Occurrences: ${countIn(group, "24h")} in 24 h, ${countIn(group, "7d")} in 7 d, ${group.users} affected users`,
    `First seen ${group.firstSeen} · last seen ${group.lastSeen} (${ago(group.lastSeen, now)} ago)`,
    `Console: ${consoleUrl(group.project, group.groupId)}`,
  ];
  return lines.map((line) => `- ${line}`);
}

function requestBlock(event: RawEvent | null): string[] {
  const request = event?.context?.httpRequest;
  if (request === undefined) return [];
  const where = [request.method, request.url, request.responseStatusCode]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return ["## Request", fenced(`${where}\n${JSON.stringify(request, null, 2)}`)];
}

function logBlock(parts: PromptParts, eventTime: string): string[] {
  if (parts.logs === null) {
    return ["## Log entries around it", `Could not be read: ${parts.logsFailure}`];
  }
  if (parts.logs.length === 0) {
    return ["## Log entries around it", "No entries of WARNING or worse within two minutes."];
  }
  const shown = nearest(parts.logs, eventTime);
  const of = shown.length < parts.logs.length ? ` (${shown.length} of ${parts.logs.length})` : "";
  return [`## Log entries around it${of}`, fenced(shown.map(logLine).join("\n"))];
}

export function errorPrompt(parts: PromptParts): string {
  const { group, event } = parts;
  const stack = event?.message ?? "";
  const location = event?.context?.reportLocation;
  return [
    `# ${group.title}`,
    ...facts(group, parts.now),
    "## Stack of the newest event",
    stack === "" ? "No event could be read for this group." : fenced(stack),
    ...(location?.filePath === undefined
      ? []
      : [
          `Reported at ${location.filePath}:${location.lineNumber ?? "?"}${location.functionName === undefined ? "" : ` in ${location.functionName}`}`,
        ]),
    ...requestBlock(event),
    ...logBlock(parts, event?.eventTime ?? group.lastSeen),
    "## Full data",
    `- Latest events (JSON): ${parts.files.events}`,
    `- Log entries (JSON): ${parts.files.logs}`,
    "The `gcloud_logs`, `gcloud_services` and `gcloud_instances` tools can dig further. " +
      "Investigate this error and propose a fix; do not change anything in Google Cloud.",
  ].join("\n\n");
}
