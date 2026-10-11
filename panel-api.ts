/**
 * What the panel `cloud` asks for at `api/<path>`. Google failures and a bad
 * `select` body are answered as data (`{ error }`), so the page shows them in
 * place; only an unknown path throws, which prifly turns into a 500.
 */

import type { PanelRequest } from "@prifly/extension-api";
import { allPages, gfetch, sayFailure } from "./google";
import type { HostApi } from "./host";
import { listProjects, type Project } from "./projects";
import { allowCloud, CLOUD_PLATFORM, sayStanding, standing } from "./scope";
import { type Chosen, readChosen, writeChosen } from "./settings";

/** The APIs this extension reads, and what the page calls them. */
export const READ_APIS: { service: string; title: string }[] = [
  { service: "logging.googleapis.com", title: "Cloud Logging" },
  { service: "clouderrorreporting.googleapis.com", title: "Error Reporting" },
  { service: "compute.googleapis.com", title: "Compute Engine" },
  { service: "run.googleapis.com", title: "Cloud Run" },
  { service: "cloudbilling.googleapis.com", title: "Cloud Billing" },
];

const PROJECTS_TTL_MS = 60_000;

type CachedProjects = { key: string; at: number; projects: Project[] };
let cachedProjects: CachedProjects | null = null;

/** Forget the project list (the tests do, between cases). */
export function forgetProjects(): void {
  cachedProjects = null;
}

export async function panelAnswer(api: HostApi, request: PanelRequest): Promise<unknown> {
  switch (request.path) {
    case "state":
      return stateAnswer(api);
    case "projects":
      return await projectsAnswer(api, request.query["fresh"] === "1");
    case "apis":
      return await apisAnswer(api, request.query["project"] ?? "");
    case "allow":
      return await allowCloud(api.connections);
    case "select":
      return selectAnswer(api, request.body);
    default:
      throw new Error(`Nothing at api/${request.path}`);
  }
}

function stateAnswer(api: HostApi): unknown {
  const now = standing(api.connections);
  const connection = "connection" in now ? now.connection : null;
  return {
    standing: now.kind,
    account: connection?.account ?? null,
    client: connection?.client ?? null,
    scopes: connection?.scopes ?? [],
    cloudPlatform: connection?.scopes.includes(CLOUD_PLATFORM) ?? false,
    message: sayStanding(now),
    chosen: readChosen(api.folder),
  };
}

async function projectsAnswer(api: HostApi, fresh: boolean): Promise<unknown> {
  const now = standing(api.connections);
  if (now.kind !== "ok" || api.connections === undefined) {
    return { error: sayStanding(now) ?? "Google Cloud is not available." };
  }
  const key = now.connection.id;
  const hit = cachedProjects;
  if (!fresh && hit !== null && hit.key === key && Date.now() - hit.at < PROJECTS_TTL_MS) {
    return { projects: hit.projects };
  }
  const answer = await listProjects(api.connections, key);
  if (!("ok" in answer)) return { error: sayFailure(answer) };
  cachedProjects = { key, at: Date.now(), projects: answer.ok };
  return { projects: answer.ok };
}

type ServicePage = { services?: { name?: string }[]; nextPageToken?: string };

async function apisAnswer(api: HostApi, project: string): Promise<unknown> {
  if (project === "") return { project, error: "No project named." };
  const now = standing(api.connections);
  if (now.kind !== "ok" || api.connections === undefined) {
    return { project, error: sayStanding(now) ?? "Google Cloud is not available." };
  }
  const { connections } = api;
  const connection = now.connection.id;
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
  if (!("ok" in answer)) return { project, error: sayFailure(answer) };
  const enabled = new Set(answer.ok.map((each) => each.name?.split("/services/")[1] ?? ""));
  const missing = READ_APIS.filter((each) => !enabled.has(each.service)).map((each) => ({
    service: each.service,
    title: each.title,
    enableUrl: `https://console.cloud.google.com/apis/library/${each.service}?project=${encodeURIComponent(project)}`,
  }));
  return { project, missing };
}

/** The body as `Chosen`, or the sentence saying what is wrong with it. */
function chosenFrom(body: unknown): Chosen | string {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const projects = record["projects"];
  const preferred = record["defaultProject"];
  if (!Array.isArray(projects) || !projects.every((each) => typeof each === "string")) {
    return "projects must be a list of project ids.";
  }
  if (typeof preferred !== "string" || (preferred !== "" && !projects.includes(preferred))) {
    return "defaultProject must be one of projects, or empty.";
  }
  return { projects: [...new Set(projects as string[])], defaultProject: preferred };
}

function selectAnswer(api: HostApi, body: unknown): Chosen | { error: string } {
  const chosen = chosenFrom(body);
  if (typeof chosen === "string") return { error: chosen };
  writeChosen(api.folder, chosen);
  return readChosen(api.folder);
}
