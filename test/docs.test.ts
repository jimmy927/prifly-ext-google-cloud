import { afterEach, describe, expect, test } from "bun:test";
import { clearDocsCache, type Discovery, trimDocs } from "../tools-docs";
import { json } from "./google-fake";
import { cleanUp, setup } from "./harness";

afterEach(() => {
  cleanUp();
  clearDocsCache();
});

const LONG = "Atomically updates the ResourceRecordSet collection. ".repeat(20);

const DNS: Discovery = {
  name: "dns",
  title: "Cloud DNS API",
  version: "v1",
  rootUrl: "https://dns.googleapis.com/",
  servicePath: "",
  resources: {
    changes: {
      methods: {
        create: {
          id: "dns.changes.create",
          httpMethod: "POST",
          path: "dns/v1/projects/{project}/managedZones/{managedZone}/changes",
          description: LONG,
          parameters: {
            project: {
              type: "string",
              location: "path",
              required: true,
              description: "Identifies the project.",
            },
            managedZone: { type: "string", location: "path", required: true },
            clientOperationId: { type: "string", location: "query" },
          },
          request: { $ref: "Change" },
          response: { $ref: "Change" },
        },
        list: {
          id: "dns.changes.list",
          httpMethod: "GET",
          path: "dns/v1/projects/{project}/managedZones/{managedZone}/changes",
        },
      },
    },
    resourceRecordSets: {
      methods: {
        list: {
          id: "dns.resourceRecordSets.list",
          httpMethod: "GET",
          path: "dns/v1/projects/{project}/managedZones/{managedZone}/rrsets",
        },
      },
    },
  },
  schemas: {
    Change: {
      type: "object",
      properties: {
        additions: { type: "array", items: { $ref: "ResourceRecordSet" } },
        deletions: { type: "array", items: { $ref: "ResourceRecordSet" } },
        id: { type: "string", description: "Output only. Unique identifier." },
        status: { type: "string", enum: ["pending", "done"], readOnly: true },
        isServing: { type: "boolean" },
      },
    },
    ResourceRecordSet: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string" },
        ttl: { type: "integer" },
        rrdatas: { type: "array", items: { type: "string" } },
      },
    },
  },
};

describe("trimDocs", () => {
  test("a filter gives the method's HTTP method, path, parameters and request body", () => {
    const text = trimDocs(DNS, "changes.create");
    expect(text).toContain(
      "dns.changes.create — POST dns/v1/projects/{project}/managedZones/{managedZone}/changes",
    );
    expect(text).toContain("    project (path, required) string — Identifies the project.");
    expect(text).toContain("    clientOperationId (query) string");
    expect(text).toContain(
      "  request Change: additions ResourceRecordSet[]; deletions ResourceRecordSet[]; isServing boolean",
    );
    expect(text).toContain(
      "    ResourceRecordSet: name string; type string; ttl integer; rrdatas string[]",
    );
    expect(text).toContain("Base URL: https://dns.googleapis.com/");
    // Output-only fields are left out of the request, and the description is one sentence.
    expect(text).not.toContain("status");
    expect(text).toContain("  Atomically updates the ResourceRecordSet collection.\n");
    expect(text).not.toContain("dns.resourceRecordSets.list");
  });

  test("no filter lists every method on one line", () => {
    const text = trimDocs(DNS, undefined);
    expect(text).toContain("3 methods.");
    expect(text).toContain(
      "dns.changes.list — GET dns/v1/projects/{project}/managedZones/{managedZone}/changes",
    );
    expect(text).toContain("dns.resourceRecordSets.list — GET");
    expect(text).not.toContain("parameters:");
  });

  test("a schema by name, output-only fields marked", () => {
    const text = trimDocs(DNS, undefined, "Change");
    expect(text).toContain("  id string (output only) — Output only.");
    expect(text).toContain("  additions ResourceRecordSet[]");
  });

  test("a huge API is cut to a sane size", () => {
    const methods = Object.fromEntries(
      Array.from({ length: 3000 }, (_, index) => [
        `m${index}`,
        {
          id: `big.things.m${index}`,
          httpMethod: "GET",
          path: `v1/things/${"x".repeat(40)}/${index}`,
        },
      ]),
    );
    const big: Discovery = {
      name: "big",
      rootUrl: "https://big.googleapis.com/",
      resources: { things: { methods } },
    };
    const all = trimDocs(big, undefined);
    expect(all.length).toBeLessThan(17_000);
    expect(all).toContain("Cut at 16000 characters");
    const some = trimDocs(big, "things");
    expect(some.length).toBeLessThan(17_000);
    expect(some).toContain("Also matching");
  });

  test("no match is said", () => {
    expect(trimDocs(DNS, "nothing-like-this")).toContain('No method matches "nothing-like-this"');
  });
});

describe("gcloud_api_docs", () => {
  test("finds the preferred version in the Discovery directory, then reads its document once", async () => {
    let reads = 0;
    const { fake, connections } = setup([
      {
        url: /discovery\.googleapis\.com\/discovery\/v1\/apis\?name=dns$/,
        answer: () =>
          json({
            items: [
              {
                name: "dns",
                version: "v1beta2",
                discoveryRestUrl: "https://dns.googleapis.com/$discovery/rest?version=v1beta2",
              },
              {
                name: "dns",
                version: "v1",
                preferred: true,
                discoveryRestUrl: "https://dns.googleapis.com/$discovery/rest?version=v1",
              },
            ],
          }),
      },
      {
        url: /dns\.googleapis\.com\/\$discovery\/rest\?version=v1$/,
        answer: () => {
          reads += 1;
          return json(DNS);
        },
      },
    ]);
    const text = await fake.callTool("gcloud_api_docs", {
      service: "dns.googleapis.com",
      method: "create",
    });
    expect(text).toContain("dns.changes.create — POST");
    await fake.callTool("gcloud_api_docs", { service: "dns" });
    expect(reads).toBe(1);
    expect(connections.requests.every((each) => each.method === "GET")).toBe(true);
    expect(fake.confirms).toHaveLength(0);
  });

  test("an unknown API is said, not thrown", async () => {
    const { fake } = setup([{ url: /discovery\/v1\/apis/, answer: () => json({}) }]);
    expect(await fake.callTool("gcloud_api_docs", { service: "nope" })).toContain(
      'The Discovery directory lists no API named "nope"',
    );
  });
});
