import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelRequest } from "@prifly/extension-api";
import { forgetProjects, panelAnswer } from "../panel-api";
import { CLOUD_PLATFORM } from "../scope";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import {
  CLOUD_ACCOUNT,
  fakeGoogle,
  GMAIL_ONLY_ACCOUNT,
  json,
  permissionDenied,
  type Route,
  serviceDisabled,
} from "./google-fake";

let folder = "";

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "panel-"));
  forgetProjects();
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function setup(accounts: FakeAccount[], routes: Route[] = []) {
  const fake = fakeConnections({
    accounts: accounts.map((each) => ({ ...each, scopes: [...each.scopes] })),
    provider: fakeGoogle(routes),
  });
  const api = fakeApi({ connections: fake.connections, folder });
  return { fake, api: api.api };
}

function ask(path: string, query: Record<string, string> = {}, body: unknown = null) {
  const request: PanelRequest = { path, query, body };
  return request;
}

const PROJECT_ROUTE: Route = {
  url: /projects:search/,
  answer: () =>
    json({
      projects: [
        { projectId: "shop-prod", displayName: "Shop", state: "ACTIVE", parent: "organizations/1" },
        { projectId: "alpha", displayName: "Alpha", state: "ACTIVE" },
      ],
    }),
};

describe("state", () => {
  test("ok", async () => {
    const { api } = setup([CLOUD_ACCOUNT]);
    expect(await panelAnswer(api, ask("state"))).toMatchObject({
      standing: "ok",
      account: "reader@example.com",
      client: "prifly",
      cloudPlatform: true,
      message: null,
      chosen: { projects: [], defaultProject: "" },
    });
  });

  test("no account", async () => {
    const { api } = setup([]);
    const answer = (await panelAnswer(api, ask("state"))) as Record<string, unknown>;
    expect(answer["standing"]).toBe("no-account");
    expect(answer["account"]).toBeNull();
    expect(answer["cloudPlatform"]).toBe(false);
    expect(String(answer["message"])).toContain("Allow Google Cloud");
  });

  test("no scope", async () => {
    const { api } = setup([GMAIL_ONLY_ACCOUNT]);
    const answer = (await panelAnswer(api, ask("state"))) as Record<string, unknown>;
    expect(answer["standing"]).toBe("no-scope");
    expect(answer["account"]).toBe("reader@example.com");
    expect(answer["cloudPlatform"]).toBe(false);
  });

  test("needs sign-in", async () => {
    const { api, fake } = setup([CLOUD_ACCOUNT]);
    fake.endpoint.revoke("google-1");
    const answer = (await panelAnswer(api, ask("state"))) as Record<string, unknown>;
    expect(answer["standing"]).toBe("needs-sign-in");
    expect(String(answer["message"])).toContain("Needs sign-in");
  });

  test("no api", async () => {
    const api = fakeApi({ folder }).api;
    const answer = (await panelAnswer(api, ask("state"))) as Record<string, unknown>;
    expect(answer["standing"]).toBe("no-api");
  });
});

describe("projects", () => {
  test("lists the projects", async () => {
    const { api } = setup([CLOUD_ACCOUNT], [PROJECT_ROUTE]);
    const answer = (await panelAnswer(api, ask("projects"))) as { projects: { id: string }[] };
    expect(answer.projects.map((each) => each.id)).toEqual(["alpha", "shop-prod"]);
  });

  test("a failure is a sentence in place of the list", async () => {
    const { api } = setup(
      [CLOUD_ACCOUNT],
      [{ url: /projects:search/, answer: () => permissionDenied("resourcemanager.projects.list") }],
    );
    const answer = (await panelAnswer(api, ask("projects"))) as { error: string };
    expect(answer.error).toContain("resourcemanager.projects.list");
  });

  test("an account without the scope gets the standing sentence", async () => {
    const { api } = setup([GMAIL_ONLY_ACCOUNT]);
    const answer = (await panelAnswer(api, ask("projects"))) as { error: string };
    expect(answer.error).toContain("Allow Google Cloud");
  });

  test("cached for a minute; fresh=1 skips the cache", async () => {
    const { api, fake } = setup([CLOUD_ACCOUNT], [PROJECT_ROUTE]);
    await panelAnswer(api, ask("projects"));
    await panelAnswer(api, ask("projects"));
    expect(fake.requests.length).toBe(1);
    await panelAnswer(api, ask("projects", { fresh: "1" }));
    expect(fake.requests.length).toBe(2);
  });

  test("a failure is not cached", async () => {
    let fail = true;
    const { api } = setup(
      [CLOUD_ACCOUNT],
      [
        {
          url: /projects:search/,
          answer: () => (fail ? permissionDenied("x.y") : json({ projects: [] })),
        },
      ],
    );
    expect(await panelAnswer(api, ask("projects"))).toHaveProperty("error");
    fail = false;
    expect(await panelAnswer(api, ask("projects"))).toEqual({ projects: [] });
  });
});

describe("apis", () => {
  const services = (names: string[]) => ({
    url: /serviceusage\.googleapis\.com\/v1\/projects\/shop-prod\/services/,
    answer: () =>
      json({ services: names.map((name) => ({ name: `projects/42/services/${name}` })) }),
  });

  test("lists the ones that are off, with enable links, billed to the project", async () => {
    const { api, fake } = setup(
      [CLOUD_ACCOUNT],
      [services(["logging.googleapis.com", "run.googleapis.com", "bigquery.googleapis.com"])],
    );
    const answer = (await panelAnswer(api, ask("apis", { project: "shop-prod" }))) as {
      project: string;
      missing: { service: string; title: string; enableUrl: string }[];
    };
    expect(answer.project).toBe("shop-prod");
    expect(answer.missing.map((each) => each.service)).toEqual([
      "clouderrorreporting.googleapis.com",
      "compute.googleapis.com",
      "cloudbilling.googleapis.com",
    ]);
    expect(answer.missing[1]).toEqual({
      service: "compute.googleapis.com",
      title: "Compute Engine",
      enableUrl:
        "https://console.cloud.google.com/apis/library/compute.googleapis.com?project=shop-prod",
    });
    expect(fake.options[0]?.project).toBe("shop-prod");
    const url = new URL(fake.requests[0]?.url ?? "");
    expect(url.searchParams.get("filter")).toBe("state:ENABLED");
  });

  test("none missing", async () => {
    const all = [
      "logging.googleapis.com",
      "clouderrorreporting.googleapis.com",
      "compute.googleapis.com",
      "run.googleapis.com",
      "cloudbilling.googleapis.com",
    ];
    const { api } = setup([CLOUD_ACCOUNT], [services(all)]);
    expect(await panelAnswer(api, ask("apis", { project: "shop-prod" }))).toEqual({
      project: "shop-prod",
      missing: [],
    });
  });

  test("follows pages", async () => {
    const { api, fake } = setup(
      [CLOUD_ACCOUNT],
      [
        {
          url: /services/,
          answer: (request) =>
            new URL(request.url).searchParams.has("pageToken")
              ? json({ services: [{ name: "projects/1/services/run.googleapis.com" }] })
              : json({
                  services: [{ name: "projects/1/services/logging.googleapis.com" }],
                  nextPageToken: "next",
                }),
        },
      ],
    );
    const answer = (await panelAnswer(api, ask("apis", { project: "shop-prod" }))) as {
      missing: { service: string }[];
    };
    expect(fake.requests.length).toBe(2);
    expect(answer.missing.map((each) => each.service)).not.toContain("run.googleapis.com");
    expect(answer.missing.length).toBe(3);
  });

  test("Service Usage off is the error", async () => {
    const { api } = setup(
      [CLOUD_ACCOUNT],
      [
        {
          url: /services/,
          answer: () => serviceDisabled("serviceusage.googleapis.com", "shop-prod"),
        },
      ],
    );
    const answer = (await panelAnswer(api, ask("apis", { project: "shop-prod" }))) as {
      project: string;
      error: string;
    };
    expect(answer.project).toBe("shop-prod");
    expect(answer.error).toContain("serviceusage.googleapis.com is not enabled");
  });

  test("no project named", async () => {
    const { api } = setup([CLOUD_ACCOUNT]);
    expect(await panelAnswer(api, ask("apis"))).toHaveProperty("error");
  });
});

describe("allow", () => {
  test("adds cloud-platform to a Gmail-only account", async () => {
    const { api, fake } = setup([GMAIL_ONLY_ACCOUNT]);
    expect(await panelAnswer(api, ask("allow", {}, {}))).toEqual({
      ok: true,
      account: "reader@example.com",
    });
    expect(fake.accounts[0]?.scopes).toContain(CLOUD_PLATFORM);
    const state = (await panelAnswer(api, ask("state"))) as Record<string, unknown>;
    expect(state["standing"]).toBe("ok");
  });

  test("revives an ended grant", async () => {
    const { api, fake } = setup([CLOUD_ACCOUNT]);
    fake.endpoint.revoke("google-1");
    expect(await panelAnswer(api, ask("allow", {}, {}))).toMatchObject({ ok: true });
    expect(fake.endpoint.isEnded("google-1")).toBe(false);
  });

  test("a refusal is { ok: false, message }", async () => {
    const fake = fakeConnections({
      accounts: [GMAIL_ONLY_ACCOUNT],
      scopes: { google: ["openid"] },
    });
    const api = fakeApi({ connections: fake.connections, folder }).api;
    expect(await panelAnswer(api, ask("allow", {}, {}))).toMatchObject({ ok: false });
  });
});

describe("select", () => {
  test("writes state.json and answers the new choice", async () => {
    const { api } = setup([CLOUD_ACCOUNT]);
    const answer = await panelAnswer(
      api,
      ask("select", {}, { projects: ["alpha", "shop-prod"], defaultProject: "shop-prod" }),
    );
    expect(answer).toEqual({ projects: ["alpha", "shop-prod"], defaultProject: "shop-prod" });
    expect(JSON.parse(readFileSync(join(folder, "state.json"), "utf8"))).toEqual(answer);
    expect(((await panelAnswer(api, ask("state"))) as { chosen: unknown }).chosen).toEqual(answer);
  });

  test("an empty default is allowed", async () => {
    const { api } = setup([CLOUD_ACCOUNT]);
    const answer = await panelAnswer(api, ask("select", {}, { projects: [], defaultProject: "" }));
    expect(answer).toEqual({ projects: [], defaultProject: "" });
  });

  test("rejects a bad body and writes nothing", async () => {
    const { api } = setup([CLOUD_ACCOUNT]);
    const bad: unknown[] = [
      null,
      "x",
      {},
      { projects: "alpha", defaultProject: "" },
      { projects: [1], defaultProject: "" },
      { projects: ["alpha"], defaultProject: 3 },
      { projects: ["alpha"], defaultProject: "other" },
    ];
    for (const body of bad) {
      expect(await panelAnswer(api, ask("select", {}, body))).toHaveProperty("error");
    }
    expect(await Bun.file(join(folder, "state.json")).exists()).toBe(false);
  });
});

test("an unknown path throws", async () => {
  const { api } = setup([CLOUD_ACCOUNT]);
  await expect(panelAnswer(api, ask("nothing"))).rejects.toThrow("Nothing at api/nothing");
});
