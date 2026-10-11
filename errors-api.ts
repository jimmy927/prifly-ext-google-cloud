/**
 * Error Reporting (v1beta1) and Cloud Logging reads for the error board, as
 * Google answers them. Only `cloud-platform` is accepted by Error Reporting,
 * which `standing` checks before anything here runs.
 */

import type { ExtensionConnectionsApi } from "@prifly/extension-api";
import { gfetch, type Result } from "./google";

export type PeriodName = "1h" | "24h" | "7d";

export const PERIODS: { name: PeriodName; api: string; bucket: string }[] = [
  { name: "1h", api: "PERIOD_1_HOUR", bucket: "600s" },
  { name: "24h", api: "PERIOD_1_DAY", bucket: "3600s" },
  { name: "7d", api: "PERIOD_1_WEEK", bucket: "86400s" },
];

export type ServiceContext = { service?: string; version?: string; resourceType?: string };

export type ErrorContext = {
  httpRequest?: {
    method?: string;
    url?: string;
    userAgent?: string;
    referrer?: string;
    responseStatusCode?: number;
    remoteIp?: string;
  };
  reportLocation?: { filePath?: string; lineNumber?: number; functionName?: string };
};

/** Counts are int64, which Google sends as strings. */
export type RawStat = {
  group?: { groupId?: string; name?: string; resolutionStatus?: string };
  count?: string | number;
  affectedUsersCount?: string | number;
  timedCounts?: { count?: string | number; startTime?: string; endTime?: string }[];
  firstSeenTime?: string;
  lastSeenTime?: string;
  affectedServices?: ServiceContext[];
  representative?: {
    eventTime?: string;
    message?: string;
    serviceContext?: ServiceContext;
    context?: ErrorContext;
  };
};

export type RawEvent = {
  eventTime?: string;
  serviceContext?: ServiceContext;
  message?: string;
  context?: ErrorContext;
};

export type LogEntry = {
  timestamp?: string;
  severity?: string;
  logName?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  protoPayload?: Record<string, unknown>;
  resource?: { type?: string; labels?: Record<string, string> };
};

const BASE = "https://clouderrorreporting.googleapis.com/v1beta1/projects";
const ENTRIES = "https://logging.googleapis.com/v2/entries:list";

export async function readStats(
  connections: ExtensionConnectionsApi,
  connection: string,
  project: string,
  period: (typeof PERIODS)[number],
): Promise<Result<RawStat[]>> {
  const query = [
    `timeRange.period=${period.api}`,
    `timedCountDuration=${period.bucket}`,
    "order=LAST_SEEN_DESC",
    "pageSize=50",
  ].join("&");
  const url = `${BASE}/${encodeURIComponent(project)}/groupStats?${query}`;
  const answer = await gfetch<{ errorGroupStats?: RawStat[] }>(connections, connection, url, {
    project,
  });
  return "ok" in answer ? { ok: answer.ok.errorGroupStats ?? [] } : answer;
}

export async function readEvents(
  connections: ExtensionConnectionsApi,
  connection: string,
  project: string,
  groupId: string,
): Promise<Result<RawEvent[]>> {
  const query = `groupId=${encodeURIComponent(groupId)}&timeRange.period=PERIOD_1_WEEK&pageSize=5`;
  const url = `${BASE}/${encodeURIComponent(project)}/events?${query}`;
  const answer = await gfetch<{ errorEvents?: RawEvent[] }>(connections, connection, url, {
    project,
  });
  return "ok" in answer ? { ok: answer.ok.errorEvents ?? [] } : answer;
}

const TWO_MINUTES = 2 * 60_000;

/** The Logging filter for WARNING and worse within two minutes of the event. */
export function logFilter(eventTime: string, service: string): string {
  const parsed = new Date(eventTime).getTime();
  const at = Number.isNaN(parsed) ? Date.now() : parsed;
  const from = new Date(at - TWO_MINUTES).toISOString();
  const to = new Date(at + TWO_MINUTES).toISOString();
  const base = `severity>=WARNING AND timestamp>="${from}" AND timestamp<="${to}"`;
  if (service === "") return base;
  const name = service.replace(/["\\]/g, "");
  const labels = ["service_name", "module_id", "function_name"]
    .map((label) => `resource.labels.${label}="${name}"`)
    .join(" OR ");
  return `${base} AND (${labels})`;
}

export async function readLogs(
  connections: ExtensionConnectionsApi,
  connection: string,
  project: string,
  eventTime: string,
  service: string,
): Promise<Result<LogEntry[]>> {
  const answer = await gfetch<{ entries?: LogEntry[] }>(connections, connection, ENTRIES, {
    project,
    body: {
      resourceNames: [`projects/${project}`],
      filter: logFilter(eventTime, service),
      orderBy: "timestamp asc",
      pageSize: 100,
    },
  });
  return "ok" in answer ? { ok: answer.ok.entries ?? [] } : answer;
}
