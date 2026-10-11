import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChosen } from "../settings";
import { cloudTools } from "../tools";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import {
  CLOUD_ACCOUNT,
  fakeGoogle,
  GMAIL_ONLY_ACCOUNT,
  json,
  permissionDenied,
  type Route,
  rateLimited,
  serviceDisabled,
} from "./google-fake";

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function temp(): string {
  const folder = mkdtempSync(join(tmpdir(), "gcloud-tools-"));
  folders.push(folder);
  return folder;
}

/** A fake api with the tools registered; `defaultProject` is chosen unless left out. */
function setup(
  routes: Route[],
  options: {
    accounts?: FakeAccount[];
    defaultProject?: string | undefined;
    scratchpad?: string;
  } = {},
) {
  const folder = temp();
  const defaultProject = "defaultProject" in options ? options.defaultProject : "shop-prod";
  if (defaultProject !== undefined) writeChosen(folder, { projects: [], defaultProject });
  const connections = fakeConnections({
    accounts: options.accounts ?? [CLOUD_ACCOUNT],
    provider: fakeGoogle(routes),
  });
  const fake = fakeApi({
    connections: connections.connections,
    folder,
    ...(options.scratchpad === undefined ? {} : { scratchpad: options.scratchpad }),
  });
  fake.api.tools?.register(cloudTools(() => fake.api));
  return { fake, connections };
}

const ALL_TOOLS = [
  ["gcloud_projects", {}],
  ["gcloud_logs", {}],
  ["gcloud_instances", {}],
  ["gcloud_services", {}],
  ["gcloud_billing", {}],
] as const;

describe("tool list", () => {
  test("five read-only tools with object schemas", () => {
    const { fake } = setup([]);
    expect(fake.tools().map((tool) => tool.name)).toEqual(ALL_TOOLS.map(([name]) => name));
    for (const tool of fake.tools()) {
      expect(tool.inputSchema["type"]).toBe("object");
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]{0,47}$/);
    }
  });
});

describe("gcloud_projects", () => {
  test("lists projects through projects:search and marks the default", async () => {
    const { fake, connections } = setup([
      {
        url: /projects:search/,
        answer: () =>
          json({
            projects: [
              { projectId: "shop-prod", displayName: "Shop (prod)", state: "ACTIVE" },
              { projectId: "shop-dev", displayName: "Shop (dev)", state: "ACTIVE" },
            ],
          }),
      },
    ]);
    const text = await fake.callTool("gcloud_projects", {});
    expect(text).toBe(
      "shop-dev — Shop (dev) (ACTIVE)\nshop-prod — Shop (prod) (ACTIVE) [default project]",
    );
    expect(connections.requests[0]?.method).toBe("GET");
  });
});

describe("gcloud_logs", () => {
  const entry = {
    timestamp: "2026-10-11T10:00:00Z",
    severity: "ERROR",
    trace: "projects/shop-prod/traces/abc123",
    textPayload: "boom\nstack line",
    resource: {
      type: "cloud_run_revision",
      labels: { project_id: "shop-prod", service_name: "api" },
    },
  };

  test("posts entries:list for the default project", async () => {
    const { fake, connections } = setup([
      { method: "POST", url: /entries:list/, answer: () => json({ entries: [entry] }) },
    ]);
    const text = await fake.callTool("gcloud_logs", { limit: 500 });
    expect(text).toBe(
      "2026-10-11T10:00:00Z | ERROR | cloud_run_revision{service_name=api} | boom | trace=abc123",
    );
    const request = connections.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://logging.googleapis.com/v2/entries:list");
    const body = (await request?.json()) as Record<string, unknown>;
    expect(body["resourceNames"]).toEqual(["projects/shop-prod"]);
    expect(body["orderBy"]).toBe("timestamp desc");
    expect(body["pageSize"]).toBe(200);
    expect(String(body["filter"])).toMatch(/^severity>=ERROR AND timestamp>="\d{4}-/);
    expect(connections.options[0]?.project).toBe("shop-prod");
  });

  test("takes filter, project and a json message", async () => {
    const { fake, connections } = setup([
      {
        method: "POST",
        url: /entries:list/,
        answer: () => json({ entries: [{ severity: "INFO", jsonPayload: { message: "hello" } }] }),
      },
    ]);
    const text = await fake.callTool("gcloud_logs", {
      project: "other-proj",
      filter: "severity>=INFO",
    });
    expect(text).toContain("INFO | hello");
    const body = (await connections.requests[0]?.json()) as Record<string, unknown>;
    expect(body["resourceNames"]).toEqual(["projects/other-proj"]);
    expect(body["filter"]).toBe("severity>=INFO");
    expect(body["pageSize"]).toBe(50);
    expect(connections.options[0]?.project).toBe("other-proj");
  });

  const many = Array.from({ length: 100 }, (_, index) => ({
    ...entry,
    textPayload: `line ${index} ${"x".repeat(200)}`,
  }));

  test("an overlong answer goes to the scratchpad, with the first lines", async () => {
    const scratchpad = temp();
    const { fake } = setup(
      [{ method: "POST", url: /entries:list/, answer: () => json({ entries: many }) }],
      { scratchpad },
    );
    const text = await fake.callTool("gcloud_logs", {});
    const files = readdirSync(scratchpad);
    expect(files).toHaveLength(1);
    const file = join(scratchpad, files[0] ?? "");
    expect(files[0]).toMatch(/^gcloud-logs-shop-prod-.+\.json$/);
    expect(text).toContain(file);
    expect(text).toContain("line 39 ");
    expect(text).not.toContain("line 40 ");
    expect(text.length).toBeLessThan(12_000);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(100);
  });

  test("without a scratchpad it says how many were cut", async () => {
    const { fake } = setup([
      { method: "POST", url: /entries:list/, answer: () => json({ entries: many }) },
    ]);
    const text = await fake.callTool("gcloud_logs", {});
    expect(text).toContain("60 more entries cut");
    expect(text).toContain("no scratchpad");
  });

  test("a project that is not a project id is refused before any request", async () => {
    const { fake, connections } = setup([
      { method: "POST", url: /entries:list/, answer: () => json({}) },
    ]);
    const text = await fake.callTool("gcloud_logs", { project: "../x" });
    expect(text).toContain("not a Google Cloud project id");
    expect(connections.requests).toHaveLength(0);
  });

  test("scratchpad note comes before the more-entries hint, which follows the limit", async () => {
    const scratchpad = temp();
    const { fake } = setup(
      [
        {
          method: "POST",
          url: /entries:list/,
          answer: () => json({ entries: many, nextPageToken: "t" }),
        },
      ],
      { scratchpad },
    );
    const text = await fake.callTool("gcloud_logs", { limit: 200 });
    expect(text.indexOf("are in ")).toBeGreaterThan(-1);
    expect(text.indexOf("are in ")).toBeLessThan(text.indexOf("More entries match"));
    expect(text).toMatch(/More entries match; narrow the filter\./);
    const lower = await fake.callTool("gcloud_logs", { limit: 100 });
    expect(lower).toContain("raise limit or narrow the filter");
  });

  test("no matches is said plainly", async () => {
    const { fake } = setup([{ method: "POST", url: /entries:list/, answer: () => json({}) }]);
    expect(await fake.callTool("gcloud_logs", { filter: "severity>=ERROR" })).toBe(
      "No log entries in shop-prod match: severity>=ERROR",
    );
  });
});

describe("gcloud_instances", () => {
  test("lists instances across zones, paged", async () => {
    const { fake, connections } = setup([
      {
        url: /aggregated\/instances/,
        answer: (request) => {
          const token = new URL(request.url).searchParams.get("pageToken");
          if (token === null) {
            return json({
              items: {
                "zones/europe-north1-a": {
                  instances: [
                    {
                      name: "web-1",
                      status: "RUNNING",
                      machineType: "zones/europe-north1-a/machineTypes/e2-small",
                      networkInterfaces: [
                        { networkIP: "10.0.0.2", accessConfigs: [{ natIP: "34.1.2.3" }] },
                      ],
                    },
                  ],
                },
                "zones/europe-north1-b": { warning: { code: "NO_RESULTS_ON_PAGE" } },
              },
              nextPageToken: "next",
            });
          }
          return json({
            items: {
              "zones/us-east1-b": {
                instances: [
                  {
                    name: "db-1",
                    status: "TERMINATED",
                    machineType: "zones/us-east1-b/machineTypes/n2-standard-4",
                    networkInterfaces: [{ networkIP: "10.1.0.5" }],
                  },
                ],
              },
            },
          });
        },
      },
    ]);
    const text = await fake.callTool("gcloud_instances", {});
    expect(text).toBe(
      "web-1 | europe-north1-a | RUNNING | e2-small | 10.0.0.2 | external 34.1.2.3\n" +
        "db-1 | us-east1-b | TERMINATED | n2-standard-4 | 10.1.0.5",
    );
    expect(connections.requests).toHaveLength(2);
    const first = new URL(connections.requests[0]?.url ?? "");
    expect(first.pathname).toBe("/compute/v1/projects/shop-prod/aggregated/instances");
    expect(first.searchParams.get("maxResults")).toBe("500");
    expect(connections.requests[0]?.method).toBe("GET");
    expect(connections.options.map((each) => each?.project)).toEqual(["shop-prod", "shop-prod"]);
  });
});

describe("gcloud_services", () => {
  test("lists Cloud Run services with traffic and a failing condition", async () => {
    const { fake, connections } = setup([
      {
        url: /run\.googleapis\.com/,
        answer: () =>
          json({
            services: [
              {
                name: "projects/shop-prod/locations/europe-north1/services/api",
                uri: "https://api-abc.a.run.app",
                latestReadyRevision:
                  "projects/shop-prod/locations/europe-north1/services/api/revisions/api-00007",
                updateTime: "2026-10-10T09:00:00Z",
                traffic: [
                  { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 90 },
                  {
                    type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
                    revision: "api-00006",
                    percent: 10,
                  },
                ],
                terminalCondition: { state: "CONDITION_SUCCEEDED" },
              },
              {
                name: "projects/shop-prod/locations/us-east1/services/worker",
                uri: "https://worker-abc.a.run.app",
                latestReadyRevision:
                  "projects/shop-prod/locations/us-east1/services/worker/revisions/worker-00002",
                updateTime: "2026-10-09T09:00:00Z",
                traffic: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }],
                terminalCondition: { state: "CONDITION_FAILED", message: "image not found" },
              },
            ],
          }),
      },
    ]);
    const lines = (await fake.callTool("gcloud_services", {})).split("\n");
    expect(lines[0]).toBe(
      "api | europe-north1 | https://api-abc.a.run.app | ready api-00007 | traffic 90% → LATEST, 10% → api-00006 | updated 2026-10-10T09:00:00Z",
    );
    expect(lines[1]).toContain("worker | us-east1 |");
    expect(lines[1]).toContain("condition CONDITION_FAILED: image not found");
    const url = connections.requests[0]?.url ?? "";
    expect(url).toBe("https://run.googleapis.com/v2/projects/shop-prod/locations/-/services");
    expect(connections.options[0]?.project).toBe("shop-prod");
  });
});

describe("gcloud_billing", () => {
  const ROUTES: Route[] = [
    {
      url: /projects\/shop-prod\/billingInfo/,
      answer: () => json({ billingEnabled: true, billingAccountName: "billingAccounts/0123-4567" }),
    },
    {
      url: /v1\/billingAccounts\/0123-4567/,
      answer: () => json({ displayName: "Shop billing", open: true }),
    },
  ];

  test("reads billing info and the account, and says spend is not available", async () => {
    const { fake, connections } = setup(ROUTES);
    const text = await fake.callTool("gcloud_billing", {});
    expect(text).toBe(
      "Project shop-prod: billing enabled\n" +
        "Billing account billingAccounts/0123-4567: Shop billing, open\n" +
        "Spend is not available in this version.",
    );
    expect(connections.requests.map((each) => each.url)).toEqual([
      "https://cloudbilling.googleapis.com/v1/projects/shop-prod/billingInfo",
      "https://cloudbilling.googleapis.com/v1/billingAccounts/0123-4567",
    ]);
    expect(connections.options.map((each) => each?.project)).toEqual(["shop-prod", "shop-prod"]);
  });

  test("a project without billing makes one call", async () => {
    const { fake, connections } = setup([
      { url: /billingInfo/, answer: () => json({ billingEnabled: false }) },
    ]);
    const text = await fake.callTool("gcloud_billing", {});
    expect(text).toContain("billing not enabled");
    expect(connections.requests).toHaveLength(1);
  });
});

describe("failures, for every tool", () => {
  test("needs sign-in when the grant is revoked, before any call to Google", async () => {
    const { fake, connections } = setup([]);
    connections.endpoint.revoke("google-1");
    for (const [name, args] of ALL_TOOLS) {
      const text = await fake.callTool(name, args);
      expect(text).toContain("Needs sign-in");
      expect(text).toContain("reader@example.com");
    }
    expect(connections.requests).toHaveLength(0);
    expect(connections.endpoint.issued("google-1")).toBe(0);
  });

  test("no Cloud scope says to allow Google Cloud, and never signs in", async () => {
    const { fake, connections } = setup([], { accounts: [GMAIL_ONLY_ACCOUNT] });
    for (const [name, args] of ALL_TOOLS) {
      const text = await fake.callTool(name, args);
      expect(text).toContain("not for Google Cloud");
      expect(text).toContain('"Allow Google Cloud"');
    }
    expect(connections.accounts[0]?.scopes).toEqual(GMAIL_ONLY_ACCOUNT.scopes);
    expect(connections.requests).toHaveLength(0);
  });

  test("no Google account at all", async () => {
    const { fake } = setup([], { accounts: [] });
    expect(await fake.callTool("gcloud_logs", {})).toContain("No Google account is connected");
  });

  test("an API that is not enabled names the API, the project and where to enable it", async () => {
    const { fake } = setup([
      { url: /.*/, answer: () => serviceDisabled("compute.googleapis.com", "shop-prod") },
    ]);
    const text = await fake.callTool("gcloud_instances", {});
    expect(text).toBe(
      "The compute.googleapis.com is not enabled in project shop-prod. Someone with access enables it at https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=shop-prod; do not retry until then.",
    );
  });

  test("permission denied names the permission", async () => {
    const { fake } = setup([
      { url: /.*/, answer: () => permissionDenied("logging.logEntries.list") },
    ]);
    const text = await fake.callTool("gcloud_logs", {});
    expect(text).toContain("the account lacks logging.logEntries.list");
  });

  test("rate limited says when to retry", async () => {
    const { fake } = setup([{ url: /.*/, answer: () => rateLimited(30) }]);
    expect(await fake.callTool("gcloud_services", {})).toBe(
      "Google rate-limited the call; try again in 30 s.",
    );
  });

  test("a failing billing account call does not hide the billing info", async () => {
    const { fake } = setup([
      {
        url: /billingInfo/,
        answer: () => json({ billingEnabled: true, billingAccountName: "billingAccounts/9" }),
      },
      { url: /billingAccounts\/9/, answer: () => permissionDenied("billing.accounts.get") },
    ]);
    const text = await fake.callTool("gcloud_billing", {});
    expect(text).toContain("billing enabled");
    expect(text).toContain("the account lacks billing.accounts.get");
    expect(text).toContain("Spend is not available");
  });
});

describe("no default project", () => {
  test("every per-project tool says what to do and calls nothing", async () => {
    const { fake, connections } = setup([], { defaultProject: undefined });
    for (const [name] of ALL_TOOLS.filter(([each]) => each !== "gcloud_projects")) {
      expect(await fake.callTool(name, {})).toBe(
        "No project given and no default project chosen: pass `project`, or the reader picks a default on the Google Cloud board.",
      );
    }
    expect(connections.requests).toHaveLength(0);
  });

  test("a project argument is enough", async () => {
    const { fake, connections } = setup(
      [{ url: /billingInfo/, answer: () => json({ billingEnabled: false }) }],
      { defaultProject: undefined },
    );
    expect(await fake.callTool("gcloud_billing", { project: "solo-proj" })).toContain(
      "Project solo-proj",
    );
    expect(connections.options[0]?.project).toBe("solo-proj");
    expect(existsSync(join(fake.api.folder, "state.json"))).toBe(false);
  });
});
