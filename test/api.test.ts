import { afterEach, describe, expect, test } from "bun:test";
import { CANCELLED, NO_CONFIRM } from "../write";
import { googleError, json, serviceDisabled } from "./google-fake";
import { cleanUp, setup } from "./harness";

afterEach(cleanUp);

const ZONES = "https://dns.googleapis.com/dns/v1/projects/shop-prod/managedZones";

describe("gcloud_api reads", () => {
  test("a GET runs at once, with no confirm card", async () => {
    const { fake, connections } = setup([
      { method: "GET", url: /managedZones/, answer: () => json({ managedZones: [] }) },
    ]);
    const text = await fake.callTool("gcloud_api", { url: ZONES });
    expect(text).toBe(`200 GET ${ZONES}\n{\n  "managedZones": []\n}`);
    expect(fake.confirms).toHaveLength(0);
    expect(connections.requests).toHaveLength(1);
    expect(connections.options[0]?.project).toBe("shop-prod");
  });

  test("service + path + query build the URL; the path's project gets the quota", async () => {
    const { fake, connections } = setup([{ url: /run\.googleapis/, answer: () => json({}) }]);
    await fake.callTool("gcloud_api", {
      service: "run.googleapis.com",
      path: "/v2/projects/other-proj/locations/-/services",
      query: { pageSize: 5, view: ["A", "B"] },
    });
    const url = new URL(connections.requests[0]?.url ?? "");
    expect(url.origin).toBe("https://run.googleapis.com");
    expect(url.pathname).toBe("/v2/projects/other-proj/locations/-/services");
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.getAll("view")).toEqual(["A", "B"]);
    expect(connections.options[0]?.project).toBe("other-proj");
  });

  test("hosts other than *.googleapis.com are refused before any request", async () => {
    const { fake, connections } = setup([{ url: /.*/, answer: () => json({}) }]);
    for (const args of [
      { url: "https://example.com/x" },
      { url: "http://dns.googleapis.com/x" },
      { url: "https://dns.googleapis.com.evil.com/x" },
      { service: "evil.com/", path: "x" },
      { service: "dns", path: "//evil.com/x" },
      { method: "POST", url: "https://example.com/x", body: {} },
    ]) {
      expect(await fake.callTool("gcloud_api", args)).toStartWith("Refused:");
    }
    expect(connections.requests).toHaveLength(0);
    expect(fake.confirms).toHaveLength(0);
  });

  test("Google's 404 and a disabled API come back as text", async () => {
    const { fake } = setup([
      { url: /missing/, answer: () => googleError(404, "NOT_FOUND", "The zone was not found.") },
      { url: /.*/, answer: () => serviceDisabled("dns.googleapis.com", "shop-prod") },
    ]);
    expect(await fake.callTool("gcloud_api", { url: `${ZONES}/missing` })).toBe(
      "Google answered 404: The zone was not found.",
    );
    const disabled = await fake.callTool("gcloud_api", { url: ZONES });
    expect(disabled).toContain("The dns.googleapis.com is not enabled in project shop-prod");
    expect(disabled).toContain("gcloud_enable_api");
  });
});

describe("gcloud_api writes", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    test(`${method} shows a confirm card with the method, URL and body, then sends`, async () => {
      const { fake, connections } = setup([
        { method, url: /managedZones/, answer: () => json({ ok: true }) },
      ]);
      const body = method === "DELETE" ? undefined : { description: "new" };
      const text = await fake.callTool("gcloud_api", {
        method,
        url: `${ZONES}/zone-a`,
        ...(body === undefined ? {} : { body }),
      });
      expect(fake.confirms).toHaveLength(1);
      const card = fake.confirms[0];
      expect(card?.details).toStartWith(`${method} ${ZONES}/zone-a`);
      if (body !== undefined) expect(card?.details).toContain('"description": "new"');
      expect(card?.summary).toContain(method);
      expect(text).toStartWith(`200 ${method} `);
      expect(connections.requests).toHaveLength(1);
      expect(connections.requests[0]?.method).toBe(method);
      if (body !== undefined) expect(await connections.requests[0]?.json()).toEqual(body);
    });

    test(`${method} cancelled at the card makes no request`, async () => {
      const { fake, connections } = setup([{ url: /.*/, answer: () => json({}) }], {
        confirm: false,
      });
      const text = await fake.callTool("gcloud_api", {
        method,
        url: `${ZONES}/zone-a`,
        ...(method === "DELETE" ? {} : { body: {} }),
      });
      expect(text).toBe(CANCELLED);
      expect(text).toBe("Not done: you cancelled");
      expect(fake.confirms).toHaveLength(1);
      expect(connections.requests).toHaveLength(0);
    });
  }

  test("a lower-case method is still a write and still confirms", async () => {
    const { fake, connections } = setup([{ url: /.*/, answer: () => json({}) }], {
      confirm: false,
    });
    expect(await fake.callTool("gcloud_api", { method: "post", url: ZONES, body: {} })).toBe(
      CANCELLED,
    );
    expect(connections.requests).toHaveLength(0);
  });

  test("without api.confirm (an older prifly) nothing is sent", async () => {
    const { fake, connections } = setup([{ url: /.*/, answer: () => json({}) }], {
      confirm: null,
    });
    expect(await fake.callTool("gcloud_api", { method: "DELETE", url: ZONES })).toBe(NO_CONFIRM);
    expect(connections.requests).toHaveLength(0);
  });

  test("a confirm card that fails is no consent: nothing is sent, and it is said", async () => {
    const { fake, connections } = setup([{ url: /.*/, answer: () => json({}) }]);
    fake.api.confirm = async () => {
      throw new Error("window gone");
    };
    expect(await fake.callTool("gcloud_api", { method: "DELETE", url: ZONES })).toBe(
      "Not done: the confirm card could not be shown (window gone)",
    );
    expect(connections.requests).toHaveLength(0);
  });

  test("an unknown method is refused", async () => {
    const { fake, connections } = setup([]);
    expect(await fake.callTool("gcloud_api", { method: "HEAD", url: ZONES })).toContain(
      "`method` is one of",
    );
    expect(connections.requests).toHaveLength(0);
  });

  test("a long-running operation is returned and points to gcloud_wait_operation", async () => {
    const operation = {
      name: "projects/shop-prod/locations/europe-north1/operations/op-1",
      metadata: {},
    };
    const { fake } = setup([{ method: "POST", url: /services/, answer: () => json(operation) }]);
    const text = await fake.callTool("gcloud_api", {
      method: "POST",
      url: "https://run.googleapis.com/v2/projects/shop-prod/locations/europe-north1/services",
      body: { template: {} },
    });
    expect(text).toContain('"name": "projects/shop-prod/locations/europe-north1/operations/op-1"');
    expect(text).toContain(
      'gcloud_wait_operation, operation: "https://run.googleapis.com/v2/projects/shop-prod/locations/europe-north1/operations/op-1"',
    );
  });
});

describe("curated writes confirm too", () => {
  test("gcloud_enable_api confirms; cancelled, no POST is made", async () => {
    const { fake, connections } = setup([{ url: /.*/, answer: () => json({}) }], {
      confirm: false,
    });
    expect(await fake.callTool("gcloud_enable_api", { service: "dns" })).toBe(CANCELLED);
    expect(fake.confirms[0]?.details).toBe(
      "POST https://serviceusage.googleapis.com/v1/projects/shop-prod/services/dns.googleapis.com:enable\n\n{}",
    );
    expect(connections.requests).toHaveLength(0);
  });

  test("gcloud_enable_api enables, and says when it is done", async () => {
    const { fake, connections } = setup([
      {
        method: "POST",
        url: /:enable$/,
        answer: () => json({ name: "operations/noop.DONE_OPERATION", done: true, response: {} }),
      },
    ]);
    expect(await fake.callTool("gcloud_enable_api", { service: "dns.googleapis.com" })).toBe(
      "Enabled dns.googleapis.com in shop-prod.",
    );
    expect(connections.requests[0]?.method).toBe("POST");
  });

  test("gcloud_enable_api disable, still running, points to the wait", async () => {
    const { fake } = setup([
      { method: "POST", url: /:disable$/, answer: () => json({ name: "operations/acf.p2-1" }) },
    ]);
    const text = await fake.callTool("gcloud_enable_api", { service: "dns", disable: true });
    expect(fake.confirms[0]?.summary).toBe("Disable dns.googleapis.com in project shop-prod");
    expect(text).toContain(
      'operation: "https://serviceusage.googleapis.com/v1/operations/acf.p2-1"',
    );
  });
});

describe("gcloud_wait_operation", () => {
  test("polls until done, read-only", async () => {
    let polls = 0;
    const { fake, connections, sleeps } = setup([
      {
        method: "GET",
        url: /operations\/op-1$/,
        answer: () => {
          polls += 1;
          return json(
            polls < 3
              ? { name: "operations/op-1" }
              : { name: "operations/op-1", done: true, response: { ok: 1 } },
          );
        },
      },
    ]);
    const text = await fake.callTool("gcloud_wait_operation", {
      operation: "operations/op-1",
      service: "serviceusage",
    });
    expect(text).toStartWith("Done.");
    expect(polls).toBe(3);
    expect(sleeps).toEqual([2000, 4000]);
    expect(connections.requests.every((each) => each.method === "GET")).toBe(true);
    expect(connections.requests[0]?.url).toBe(
      "https://serviceusage.googleapis.com/v1/operations/op-1",
    );
    expect(fake.confirms).toHaveLength(0);
  });

  test("a failed Compute operation says why", async () => {
    const { fake } = setup([
      {
        url: /operations\/op-2/,
        answer: () =>
          json({
            kind: "compute#operation",
            status: "DONE",
            error: { errors: [{ message: "Quota exceeded" }] },
          }),
      },
    ]);
    const text = await fake.callTool("gcloud_wait_operation", {
      operation:
        "https://compute.googleapis.com/compute/v1/projects/shop-prod/zones/a/operations/op-2",
    });
    expect(text).toStartWith("The operation failed: Quota exceeded");
  });

  test("still running when the time is up says how to go on", async () => {
    const { fake } = setup([
      { url: /.*/, answer: () => json({ kind: "dns#change", id: "7", status: "pending" }) },
    ]);
    const url = "https://dns.googleapis.com/dns/v1/projects/shop-prod/managedZones/z/changes/7";
    const text = await fake.callTool("gcloud_wait_operation", {
      operation: url,
      timeoutSeconds: 1,
    });
    expect(text).toStartWith(
      `Still running after the wait; call gcloud_wait_operation again with operation: "${url}"`,
    );
  });

  test("a URL outside googleapis.com is refused", async () => {
    const { fake, connections } = setup([]);
    expect(
      await fake.callTool("gcloud_wait_operation", {
        operation: "https://example.com/operations/1",
      }),
    ).toStartWith("Refused:");
    expect(connections.requests).toHaveLength(0);
  });
});
