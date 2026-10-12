/**
 * Which of the APIs this extension reads are switched off in each project the
 * board shows. The board asks on every keystroke and cannot wait, so a project
 * is checked once in the background and its row says "Checking…" until the
 * answer lands; an answer is kept for a minute.
 */

import { allPages, gfetch, type Result, sayFailure } from "./google";
import type { HostApi } from "./host";

/** The APIs this extension reads, and what the board calls them. */
export const READ_APIS: { service: string; title: string }[] = [
  { service: "logging.googleapis.com", title: "Cloud Logging" },
  { service: "clouderrorreporting.googleapis.com", title: "Error Reporting" },
  { service: "compute.googleapis.com", title: "Compute Engine" },
  { service: "run.googleapis.com", title: "Cloud Run" },
  { service: "cloudbilling.googleapis.com", title: "Cloud Billing" },
];

const TTL_MS = 60_000;

export type MissingApi = { service: string; title: string; enableUrl: string };

type Checked =
  | { kind: "reading"; connection: string }
  | { kind: "done"; connection: string; at: number; missing: MissingApi[] }
  | { kind: "failed"; connection: string; at: number; message: string };

const checks = new Map<string, Checked>();
/** Projects whose settled answer is being read again. */
const refreshing = new Set<string>();

/** Forget every answer (the tests do, between cases). */
export function forgetApis(): void {
  checks.clear();
  refreshing.clear();
}

type ServicePage = { services?: { name?: string }[]; nextPageToken?: string };

async function readMissing(
  api: HostApi,
  connection: string,
  project: string,
): Promise<Result<MissingApi[]>> {
  const { connections } = api;
  if (connections === undefined) return { failed: { status: 0, message: "No connections." } };
  const base = `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(project)}/services`;
  const answer = await allPages(
    (token) => {
      const url = new URL(base);
      url.searchParams.set("filter", "state:ENABLED");
      url.searchParams.set("pageSize", "200");
      if (token !== undefined) url.searchParams.set("pageToken", token);
      return gfetch<ServicePage>(connections, connection, url.toString(), { project });
    },
    (page: ServicePage) => page.services,
  );
  if (!("ok" in answer)) return answer;
  const enabled = new Set(answer.ok.map((each) => each.name?.split("/services/")[1] ?? ""));
  return {
    ok: READ_APIS.filter((each) => !enabled.has(each.service)).map((each) => ({
      service: each.service,
      title: each.title,
      enableUrl: `https://console.cloud.google.com/apis/library/${each.service}?project=${encodeURIComponent(project)}`,
    })),
  };
}

function start(api: HostApi, connection: string, project: string): void {
  // A refresh keeps the last answer on the card until the new one lands.
  const before = checks.get(project);
  if (before === undefined || before.connection !== connection || before.kind === "reading") {
    checks.set(project, { kind: "reading", connection });
  } else {
    refreshing.add(project);
  }
  void readMissing(api, connection, project)
    .catch((error: unknown): Result<MissingApi[]> => {
      api.log("apis-failed", { project, message: String(error) });
      return { failed: { status: 0, message: String(error) } };
    })
    .then((answer) => {
      refreshing.delete(project);
      checks.set(
        project,
        "ok" in answer
          ? { kind: "done", connection, at: Date.now(), missing: answer.ok }
          : { kind: "failed", connection, at: Date.now(), message: sayFailure(answer) },
      );
    });
}

/** The APIs switched off in `project`, or null while they are being checked. */
export function apisOf(
  api: HostApi,
  connection: string,
  project: string,
): MissingApi[] | { failure: string } | null {
  const found = checks.get(project);
  if (found === undefined || found.connection !== connection) {
    start(api, connection, project);
    return null;
  }
  if (found.kind === "reading") return null;
  if (Date.now() - found.at >= TTL_MS && !refreshing.has(project)) start(api, connection, project);
  return found.kind === "done" ? found.missing : { failure: found.message };
}

/** Resolves when every check under way has landed (the tests wait on it). */
export async function apisRead(): Promise<void> {
  while (refreshing.size > 0 || [...checks.values()].some((each) => each.kind === "reading")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
