/**
 * One Error Reporting group as the board and the prompt see it: read from the
 * three `groupStats` answers (1 h, 24 h, 7 d), resolved and muted groups left
 * out, and the words and tone a card wears.
 */

import type { LaunchSpark } from "@prifly/extension-api";
import type { PeriodName, RawStat, ServiceContext } from "./errors-api";

export type Series = { counts: number[]; total: number };

export type ErrorGroup = {
  project: string;
  groupId: string;
  /** The first line of the representative message. */
  title: string;
  service: string;
  version: string;
  resourceType: string;
  users: number;
  firstSeen: string;
  lastSeen: string;
  series: Partial<Record<PeriodName, Series>>;
};

export function num(value: string | number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function consoleUrl(project: string, groupId: string): string {
  return `https://console.cloud.google.com/errors/detail/${encodeURIComponent(groupId)}?project=${encodeURIComponent(project)}`;
}

const TITLE_MAX = 160;

export function titleOf(message: string | undefined, groupId: string): string {
  const first = (message ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
  const line = first.trim();
  if (line === "") return `Error group ${groupId}`;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function seriesOf(stat: RawStat | undefined): Series | undefined {
  if (stat === undefined) return undefined;
  const counts = [...(stat.timedCounts ?? [])]
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""))
    .map((each) => num(each.count));
  return { counts, total: num(stat.count) };
}

function serviceOf(stat: RawStat): ServiceContext {
  return stat.representative?.serviceContext ?? stat.affectedServices?.[0] ?? {};
}

function isOpen(stat: RawStat): boolean {
  const status = stat.group?.resolutionStatus;
  return status !== "RESOLVED" && status !== "MUTED";
}

function byId(stats: RawStat[] | null): Map<string, RawStat> {
  const found = new Map<string, RawStat>();
  for (const stat of stats ?? []) {
    const id = stat.group?.groupId;
    if (id !== undefined) found.set(id, stat);
  }
  return found;
}

/** The three series of a group; one missing from an answer that did arrive had nothing then. */
function seriesFor(
  groupId: string,
  stat: RawStat,
  hours: Map<string, RawStat> | null,
  weeks: Map<string, RawStat> | null,
): ErrorGroup["series"] {
  const none: Series = { counts: [], total: 0 };
  const series: ErrorGroup["series"] = {};
  if (hours !== null) series["1h"] = seriesOf(hours.get(groupId)) ?? none;
  const daily = seriesOf(stat);
  if (daily !== undefined) series["24h"] = daily;
  if (weeks !== null) series["7d"] = seriesOf(weeks.get(groupId)) ?? none;
  return series;
}

/** The open groups of the 24 h answer, with the 1 h and 7 d series of the same groups. */
export function groupsOf(
  project: string,
  day: RawStat[],
  hour: RawStat[] | null,
  week: RawStat[] | null,
): ErrorGroup[] {
  const hours = hour === null ? null : byId(hour);
  const weeks = week === null ? null : byId(week);
  const groups: ErrorGroup[] = [];
  for (const stat of day) {
    const groupId = stat.group?.groupId;
    if (groupId === undefined || !isOpen(stat)) continue;
    const context = serviceOf(stat);
    groups.push({
      project,
      groupId,
      title: titleOf(stat.representative?.message, groupId),
      service: context.service ?? "",
      version: context.version ?? "",
      resourceType: context.resourceType ?? "",
      users: num(stat.affectedUsersCount),
      firstSeen: stat.firstSeenTime ?? "",
      lastSeen: stat.lastSeenTime ?? "",
      series: seriesFor(groupId, stat, hours, weeks),
    });
  }
  return groups;
}

export function countIn(group: ErrorGroup, period: PeriodName): number {
  return group.series[period]?.total ?? 0;
}

/** "5 min", "3 h", "2 d": how long before `now` the time was. */
export function ago(time: string, now: number): string {
  const at = new Date(time).getTime();
  if (Number.isNaN(at)) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

/**
 * Critical: five or more in the last hour, or a busy day (50+) still going
 * within the hour. Warning: seen within six hours. Otherwise info.
 */
export function toneOf(group: ErrorGroup, now: number): "critical" | "warning" | "info" {
  const sinceSeen = now - new Date(group.lastSeen).getTime();
  if (countIn(group, "1h") >= 5) return "critical";
  if (countIn(group, "24h") >= 50 && sinceSeen < 3_600_000) return "critical";
  return sinceSeen < 6 * 3_600_000 ? "warning" : "info";
}

export function sparksOf(group: ErrorGroup): LaunchSpark[] {
  const sparks: LaunchSpark[] = [];
  for (const period of ["1h", "24h", "7d"] as const) {
    const series = group.series[period];
    if (series !== undefined) {
      sparks.push({ period, counts: series.counts, total: series.total });
    }
  }
  return sparks;
}
