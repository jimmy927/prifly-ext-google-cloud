import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allPages, gfetch, googleUrl, gsend, type Result, sayFailure } from "../google";
import { listProjects } from "../projects";
import { allowCloud, CLOUD_PLATFORM, sayStanding, standing } from "../scope";
import { chosenOf, readChosen, writeChosen } from "../settings";
import { fakeConnections } from "./fake-api";
import {
  CLOUD_ACCOUNT,
  fakeGoogle,
  GMAIL_ONLY_ACCOUNT,
  json,
  permissionDenied,
  rateLimited,
  serviceDisabled,
} from "./google-fake";

const URL_PROJECTS = "https://cloudresourcemanager.googleapis.com/v3/projects:search";

describe("gfetch", () => {
  test("passes the project on, so prifly sets x-goog-user-project", async () => {
    const fake = fakeConnections({
      accounts: [CLOUD_ACCOUNT],
      provider: fakeGoogle([{ url: /projects:search/, answer: () => json({ projects: [] }) }]),
    });
    const answer = await gfetch(fake.connections, "google-1", URL_PROJECTS, {
      project: "shop-prod",
    });
    expect(answer).toEqual({ ok: { projects: [] } });
    expect(fake.options[0]?.project).toBe("shop-prod");
    expect(fake.requests[0]?.method).toBe("GET");
  });

  test("a body is a JSON POST", async () => {
    const fake = fakeConnections({
      accounts: [CLOUD_ACCOUNT],
      provider: fakeGoogle([
        {
          method: "POST",
          url: /entries:list/,
          answer: async (request) => json(await request.json()),
        },
      ]),
    });
    const answer = await gfetch(
      fake.connections,
      "google-1",
      "https://logging.googleapis.com/v2/entries:list",
      {
        body: { pageSize: 5 },
      },
    );
    expect(answer).toEqual({ ok: { pageSize: 5 } });
    expect(fake.requests[0]?.headers.get("content-type")).toBe("application/json");
  });

  test("Google's error shapes become typed failures", async () => {
    const answers = [
      serviceDisabled("logging.googleapis.com", "shop-prod"),
      permissionDenied("compute.instances.list"),
      rateLimited(12),
      json({ error: { code: 500, message: "backend" } }, 500),
    ];
    const fake = fakeConnections({
      accounts: [CLOUD_ACCOUNT],
      provider: () => answers.shift() ?? json({}),
    });
    const results: Result<unknown>[] = [];
    for (let i = 0; i < 4; i += 1)
      results.push(await gfetch(fake.connections, "google-1", URL_PROJECTS));
    expect(results[0]).toEqual({
      apiDisabled: {
        service: "logging.googleapis.com",
        project: "shop-prod",
        enableUrl:
          "https://console.developers.google.com/apis/api/logging.googleapis.com/overview?project=shop-prod",
      },
    });
    expect(results[1]).toMatchObject({ denied: { permission: "compute.instances.list" } });
    expect(results[2]).toEqual({ rateLimited: { retryAfter: 12 } });
    expect(results[3]).toEqual({ failed: { status: 500, message: "backend" } });
  });

  test("an ended grant is needs-sign-in, said without a retry", async () => {
    const fake = fakeConnections({ accounts: [CLOUD_ACCOUNT], provider: () => json({}) });
    fake.endpoint.revoke("google-1");
    const answer = await gfetch(fake.connections, "google-1", URL_PROJECTS);
    expect(answer).toEqual({
      needsSignIn: { connection: "google-1", account: "reader@example.com" },
    });
    if ("ok" in answer) throw new Error("expected a failure");
    expect(sayFailure(answer)).toContain("Sign in again");
    expect(sayFailure(answer)).toContain("Do not retry");
  });

  test("an empty or non-JSON answer and a refused request never throw", async () => {
    const answers = [new Response("", { status: 200 }), new Response("plain", { status: 200 })];
    const fake = fakeConnections({
      accounts: [CLOUD_ACCOUNT],
      provider: () => answers.shift() ?? json({}),
    });
    expect(await gsend(fake.connections, "google-1", URL_PROJECTS, { method: "DELETE" })).toEqual({
      ok: { status: 200, body: {} },
    });
    expect(await gsend(fake.connections, "google-1", URL_PROJECTS)).toEqual({
      ok: { status: 200, body: "plain" },
    });
    const refused = await gsend(fake.connections, "no-such-connection", URL_PROJECTS);
    expect(refused).toMatchObject({ failed: { status: 0 } });
    if ("ok" in refused) throw new Error("expected a failure");
    expect(sayFailure(refused)).toContain("The request was not sent: No connection");
  });

  test("only https *.googleapis.com URLs are Google's", () => {
    expect(googleUrl("https://dns.googleapis.com/dns/v1/x")?.hostname).toBe("dns.googleapis.com");
    expect(googleUrl("http://dns.googleapis.com/x")).toBeNull();
    expect(googleUrl("https://evil.com/x")).toBeNull();
    expect(googleUrl("https://googleapis.com.evil.com/x")).toBeNull();
    expect(googleUrl("https://user@dns.googleapis.com/x")).toBeNull();
    expect(googleUrl("https://dns.googleapis.com:8443/x")).toBeNull();
    expect(googleUrl("not a url")).toBeNull();
  });

  test("allPages follows nextPageToken and stops at the last page", async () => {
    const pages = [{ items: [1, 2], nextPageToken: "b" }, { items: [3] }];
    const tokens: (string | undefined)[] = [];
    const answer = await allPages(
      async (token) => {
        tokens.push(token);
        return { ok: pages.shift() ?? { items: [] } };
      },
      (page: { items?: number[] }) => page.items,
    );
    expect(answer).toEqual({ ok: [1, 2, 3] });
    expect(tokens).toEqual([undefined, "b"]);
  });
});

describe("listProjects", () => {
  test("pages through projects:search and sorts by id", async () => {
    const fake = fakeConnections({
      accounts: [CLOUD_ACCOUNT],
      provider: fakeGoogle([
        {
          url: /projects:search.*pageToken=p2/,
          answer: () =>
            json({ projects: [{ projectId: "alpha", displayName: "Alpha", state: "ACTIVE" }] }),
        },
        {
          url: /projects:search/,
          answer: () =>
            json({
              projects: [
                { projectId: "zeta", state: "ACTIVE", parent: "organizations/1" },
                { displayName: "no id" },
              ],
              nextPageToken: "p2",
            }),
        },
      ]),
    });
    expect(await listProjects(fake.connections, "google-1")).toEqual({
      ok: [
        { id: "alpha", name: "Alpha", state: "ACTIVE", parent: "" },
        { id: "zeta", name: "zeta", state: "ACTIVE", parent: "organizations/1" },
      ],
    });
  });
});

describe("standing", () => {
  test("no account, no scope, ended, ok", () => {
    expect(standing(fakeConnections().connections).kind).toBe("no-account");
    const gmail = fakeConnections({ accounts: [{ ...GMAIL_ONLY_ACCOUNT }] });
    expect(standing(gmail.connections).kind).toBe("no-scope");
    const cloud = fakeConnections({ accounts: [{ ...CLOUD_ACCOUNT }] });
    expect(standing(cloud.connections).kind).toBe("ok");
    cloud.endpoint.revoke("google-1");
    expect(standing(cloud.connections).kind).toBe("needs-sign-in");
    expect(sayStanding(standing(cloud.connections))).toContain("Sign in again");
    expect(standing(undefined).kind).toBe("no-api");
  });

  test("allowCloud adds cloud-platform to the account already connected", async () => {
    const fake = fakeConnections({ accounts: [{ ...GMAIL_ONLY_ACCOUNT }] });
    const answer = await allowCloud(fake.connections);
    expect(answer).toEqual({ ok: true, account: "reader@example.com" });
    expect(fake.accounts).toHaveLength(1);
    expect(fake.accounts[0]?.scopes).toContain(CLOUD_PLATFORM);
    expect(standing(fake.connections).kind).toBe("ok");
  });
});

describe("settings", () => {
  let folder = "";
  afterEach(() => {
    if (folder !== "") rmSync(folder, { recursive: true, force: true });
  });

  test("the choice round-trips, and the first project is the default", () => {
    folder = mkdtempSync(join(tmpdir(), "gcloud-"));
    expect(readChosen(folder)).toEqual({ projects: [], defaultProject: "" });
    writeChosen(folder, { projects: ["a", "b"], defaultProject: "" });
    expect(readChosen(folder)).toEqual({ projects: ["a", "b"], defaultProject: "a" });
    writeFileSync(join(folder, "state.json"), "{not json");
    expect(readChosen(folder)).toEqual({ projects: [], defaultProject: "" });
  });

  test("tolerant on read", () => {
    expect(chosenOf({ projects: ["a", 3, "a"], defaultProject: 7 })).toEqual({
      projects: ["a"],
      defaultProject: "a",
    });
  });
});
