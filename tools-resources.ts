/** `gcloud_projects`, `gcloud_instances`, `gcloud_services`, `gcloud_billing`. */

import { allPages, gfetch, type Result } from "./google";
import { listProjects } from "./projects";
import { readChosen } from "./settings";
import { lastSegment, orSentence, type Ready, type ToolSpec } from "./tools-common";

// ---- projects

async function runProjects(ready: Ready): Promise<string> {
  const answer = orSentence(await listProjects(ready.connections, ready.connection));
  if ("sentence" in answer) return answer.sentence;
  if (answer.value.length === 0) return "This account sees no Google Cloud projects.";
  const chosen = readChosen(ready.api.folder).defaultProject;
  return answer.value
    .map((each) => {
      const mark = each.id === chosen ? " [default project]" : "";
      return `${each.id} — ${each.name} (${each.state})${mark}`;
    })
    .join("\n");
}

export const projectsTool: ToolSpec = {
  name: "gcloud_projects",
  description:
    "The Google Cloud projects the reader's account can see (id — name (state)), with the default project marked. Read-only.",
  perProject: false,
  properties: {},
  run: runProjects,
};

// ---- instances

type Instance = {
  name?: string;
  status?: string;
  machineType?: string;
  networkInterfaces?: { networkIP?: string; accessConfigs?: { natIP?: string }[] }[];
};

type InstancesPage = {
  items?: Record<string, { instances?: Instance[] }>;
  nextPageToken?: string;
};

function instanceLine(zone: string, each: Instance): string {
  const nic = each.networkInterfaces?.[0];
  const external = nic?.accessConfigs?.find((config) => config.natIP)?.natIP;
  return [
    each.name ?? "?",
    zone,
    each.status ?? "?",
    lastSegment(each.machineType),
    nic?.networkIP ?? "no internal IP",
    external === undefined ? "" : `external ${external}`,
  ]
    .filter((part) => part !== "")
    .join(" | ");
}

function instanceLines(page: InstancesPage): string[] {
  return Object.entries(page.items ?? {}).flatMap(([zone, scoped]) =>
    (scoped.instances ?? []).map((each) => instanceLine(lastSegment(zone), each)),
  );
}

async function runInstances(ready: Ready): Promise<string> {
  const base = `https://compute.googleapis.com/compute/v1/projects/${ready.project}/aggregated/instances`;
  const answer = orSentence(
    await allPages((token) => {
      const url = new URL(base);
      url.searchParams.set("maxResults", "500");
      if (token !== undefined) url.searchParams.set("pageToken", token);
      return gfetch<InstancesPage>(ready.connections, ready.connection, url.toString(), {
        project: ready.project,
      });
    }, instanceLines),
  );
  if ("sentence" in answer) return answer.sentence;
  if (answer.value.length === 0) return `No VM instances in ${ready.project}.`;
  return answer.value.join("\n");
}

export const instancesTool: ToolSpec = {
  name: "gcloud_instances",
  description:
    "Compute Engine VM instances of a Google Cloud project, all zones: name, zone, status, machine type, IPs. Read-only.",
  perProject: true,
  properties: {},
  run: runInstances,
};

// ---- Cloud Run services

type RunService = {
  name?: string;
  uri?: string;
  latestReadyRevision?: string;
  updateTime?: string;
  traffic?: { type?: string; revision?: string; percent?: number }[];
  terminalCondition?: { state?: string; message?: string };
};

type ServicesPage = { services?: RunService[]; nextPageToken?: string };

function trafficOf(service: RunService): string {
  return (service.traffic ?? [])
    .map((each) => {
      const target = each.type?.endsWith("LATEST") ? "LATEST" : lastSegment(each.revision);
      return `${each.percent ?? 0}% → ${target}`;
    })
    .join(", ");
}

function serviceLine(service: RunService): string {
  const parts = (service.name ?? "").split("/");
  const state = service.terminalCondition?.state;
  const problem =
    state === undefined || state === "CONDITION_SUCCEEDED"
      ? ""
      : `condition ${state}${service.terminalCondition?.message ? `: ${service.terminalCondition.message}` : ""}`;
  return [
    lastSegment(service.name),
    parts[3] ?? "",
    service.uri ?? "",
    `ready ${lastSegment(service.latestReadyRevision)}`,
    `traffic ${trafficOf(service)}`,
    `updated ${service.updateTime ?? "?"}`,
    problem,
  ]
    .filter((part) => part !== "")
    .join(" | ");
}

async function runServices(ready: Ready): Promise<string> {
  const base = `https://run.googleapis.com/v2/projects/${ready.project}/locations/-/services`;
  const answer = orSentence(
    await allPages(
      (token) => {
        const url = new URL(base);
        if (token !== undefined) url.searchParams.set("pageToken", token);
        return gfetch<ServicesPage>(ready.connections, ready.connection, url.toString(), {
          project: ready.project,
        });
      },
      (page: ServicesPage) => page.services,
    ),
  );
  if ("sentence" in answer) return answer.sentence;
  if (answer.value.length === 0) return `No Cloud Run services in ${ready.project}.`;
  return answer.value.map(serviceLine).join("\n");
}

export const servicesTool: ToolSpec = {
  name: "gcloud_services",
  description:
    "Cloud Run services of a Google Cloud project, all regions: name, region, URL, ready revision, traffic split, last update, and any failing condition. Read-only.",
  perProject: true,
  properties: {},
  run: runServices,
};

// ---- billing

type BillingInfo = { billingEnabled?: boolean; billingAccountName?: string };
type BillingAccount = { displayName?: string; open?: boolean };

const NO_SPEND = "Spend is not available in this version.";

async function accountLine(ready: Ready, name: string): Promise<string> {
  const account: Result<BillingAccount> = await gfetch(
    ready.connections,
    ready.connection,
    `https://cloudbilling.googleapis.com/v1/${name}`,
    { project: ready.project },
  );
  const answer = orSentence(account);
  if ("sentence" in answer) return `Billing account ${name}: could not read it. ${answer.sentence}`;
  const { displayName, open } = answer.value;
  return `Billing account ${name}: ${displayName ?? "(no name)"}, ${open ? "open" : "closed"}`;
}

async function runBilling(ready: Ready): Promise<string> {
  const info = orSentence(
    await gfetch<BillingInfo>(
      ready.connections,
      ready.connection,
      `https://cloudbilling.googleapis.com/v1/projects/${ready.project}/billingInfo`,
      { project: ready.project },
    ),
  );
  if ("sentence" in info) return info.sentence;
  const { billingEnabled, billingAccountName } = info.value;
  const lines = [`Project ${ready.project}: billing ${billingEnabled ? "enabled" : "not enabled"}`];
  if (billingAccountName) lines.push(await accountLine(ready, billingAccountName));
  lines.push(NO_SPEND);
  return lines.join("\n");
}

export const billingTool: ToolSpec = {
  name: "gcloud_billing",
  description:
    "Whether billing is enabled for a Google Cloud project, and its billing account (name, open or closed). Does not report spend. Read-only.",
  perProject: true,
  properties: {},
  run: runBilling,
};
