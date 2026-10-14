import { afterEach, describe, expect, test } from "bun:test";
import { changeBody, fqdn } from "../tools-dns";
import { CANCELLED } from "../write";
import { googleError, json, type Route } from "./google-fake";
import { cleanUp, setup } from "./harness";

afterEach(cleanUp);

const BASE = "https://dns.googleapis.com/dns/v1/projects/shop-prod/managedZones/shop";
const EXISTING = {
  kind: "dns#resourceRecordSet",
  name: "www.shop.example.",
  type: "A",
  ttl: 300,
  rrdatas: ["1.1.1.1"],
};

/** A zone `shop` for shop.example., an existing A record for www, and changes.create. */
function routes(posted: unknown[]): Route[] {
  return [
    {
      method: "GET",
      url: /managedZones\/shop$/,
      answer: () => json({ name: "shop", dnsName: "shop.example." }),
    },
    {
      method: "GET",
      url: /rrsets\/www\.shop\.example\.\/A$/,
      answer: () => json(EXISTING),
    },
    {
      method: "GET",
      url: /rrsets\/[^/]+\/[^/]+$/,
      answer: () => googleError(404, "NOT_FOUND", "The resource record set was not found."),
    },
    {
      method: "POST",
      url: /managedZones\/shop\/changes$/,
      answer: async (request) => {
        posted.push(await request.json());
        return json({ kind: "dns#change", id: "42", status: "pending" });
      },
    },
  ];
}

describe("names", () => {
  test("relative, apex and fully qualified names", () => {
    expect(fqdn("www", "shop.example.")).toBe("www.shop.example.");
    expect(fqdn("@", "shop.example.")).toBe("shop.example.");
    expect(fqdn("www.shop.example", "shop.example.")).toBe("www.shop.example.");
    expect(fqdn("www.shop.example.", "shop.example.")).toBe("www.shop.example.");
  });
});

describe("the changes.create body", () => {
  const wanted = { name: "www.shop.example.", type: "A", ttl: 60, rrdatas: ["2.2.2.2"] };
  test("create adds, delete deletes, replace does both", () => {
    expect(changeBody("create", undefined, wanted)).toEqual({ additions: [wanted] });
    expect(changeBody("delete", EXISTING, undefined)).toEqual({ deletions: [EXISTING] });
    expect(changeBody("replace", EXISTING, wanted)).toEqual({
      deletions: [EXISTING],
      additions: [wanted],
    });
  });
});

describe("gcloud_dns_change", () => {
  test("create: an A record, confirmed, posted as additions", async () => {
    const posted: unknown[] = [];
    const { fake, connections } = setup(routes(posted));
    const text = await fake.callTool("gcloud_dns_change", {
      action: "create",
      zone: "shop",
      name: "api",
      type: "a",
      rrdatas: ["3.3.3.3"],
    });
    const body = {
      additions: [{ name: "api.shop.example.", type: "A", ttl: 300, rrdatas: ["3.3.3.3"] }],
    };
    expect(posted).toEqual([body]);
    expect(fake.confirms).toHaveLength(1);
    expect(fake.confirms[0]?.title).toBe("Add a DNS record");
    expect(fake.confirms[0]?.summary).toBe("Add api.shop.example. A 300 3.3.3.3 in zone shop");
    expect(fake.confirms[0]?.details).toBe(
      `POST ${BASE}/changes\n\n${JSON.stringify(body, null, 2)}`,
    );
    expect(text).toContain("Change 42 in zone shop: pending.");
    expect(text).toContain(`gcloud_wait_operation, operation: "${BASE}/changes/42"`);
    expect(connections.options.every((each) => each?.project === "shop-prod")).toBe(true);
  });

  test("replace: deletes the record set as it is and adds the new one", async () => {
    const posted: unknown[] = [];
    const { fake } = setup(routes(posted));
    await fake.callTool("gcloud_dns_change", {
      action: "replace",
      zone: "shop",
      name: "www",
      type: "A",
      rrdatas: "2.2.2.2",
      ttl: 60,
    });
    expect(posted).toEqual([
      {
        deletions: [EXISTING],
        additions: [{ name: "www.shop.example.", type: "A", ttl: 60, rrdatas: ["2.2.2.2"] }],
      },
    ]);
  });

  test("delete: deletions only", async () => {
    const posted: unknown[] = [];
    const { fake } = setup(routes(posted));
    await fake.callTool("gcloud_dns_change", {
      action: "delete",
      zone: "shop",
      name: "www.shop.example.",
      type: "A",
    });
    expect(posted).toEqual([{ deletions: [EXISTING] }]);
    expect(fake.confirms[0]?.title).toBe("Delete a DNS record");
  });

  test("cancelled: no change is posted", async () => {
    const posted: unknown[] = [];
    const { fake, connections } = setup(routes(posted), { confirm: false });
    const text = await fake.callTool("gcloud_dns_change", {
      action: "create",
      zone: "shop",
      name: "api",
      type: "A",
      rrdatas: ["3.3.3.3"],
    });
    expect(text).toBe(CANCELLED);
    expect(posted).toEqual([]);
    expect(connections.requests.every((each) => each.method === "GET")).toBe(true);
  });

  test("a record that is not there is said, and nothing is asked or posted", async () => {
    const posted: unknown[] = [];
    const { fake } = setup(routes(posted));
    const text = await fake.callTool("gcloud_dns_change", {
      action: "delete",
      zone: "shop",
      name: "gone",
      type: "TXT",
    });
    expect(text).toContain("Could not read the record set gone.shop.example. TXT");
    expect(text).toContain("Google answered 404");
    expect(fake.confirms).toHaveLength(0);
    expect(posted).toEqual([]);
  });

  test("missing data is refused before any request", async () => {
    const { fake, connections } = setup([]);
    expect(
      await fake.callTool("gcloud_dns_change", {
        action: "create",
        zone: "shop",
        name: "a",
        type: "A",
      }),
    ).toContain("Give `rrdatas`");
    expect(await fake.callTool("gcloud_dns_change", { action: "upsert" })).toContain("`action`");
    expect(connections.requests).toHaveLength(0);
  });
});

describe("DNS reads", () => {
  test("zones and record sets, one per line", async () => {
    const { fake, connections } = setup([
      {
        url: /managedZones$/,
        answer: () =>
          json({
            managedZones: [{ name: "shop", dnsName: "shop.example.", visibility: "public" }],
          }),
      },
      {
        url: /rrsets/,
        answer: () =>
          json({
            rrsets: [
              EXISTING,
              { name: "shop.example.", type: "MX", ttl: 3600, rrdatas: ["1 mx.", "5 mx2."] },
            ],
          }),
      },
    ]);
    expect(await fake.callTool("gcloud_dns_zones", {})).toBe("shop | shop.example. | public");
    expect(
      await fake.callTool("gcloud_dns_records", {
        zone: "shop",
        name: "www.shop.example",
        type: "a",
      }),
    ).toBe("www.shop.example. A 300 1.1.1.1\nshop.example. MX 3600 1 mx., 5 mx2.");
    const url = new URL(connections.requests[1]?.url ?? "");
    expect(url.pathname).toBe("/dns/v1/projects/shop-prod/managedZones/shop/rrsets");
    expect(url.searchParams.get("name")).toBe("www.shop.example.");
    expect(url.searchParams.get("type")).toBe("A");
    expect(fake.confirms).toHaveLength(0);
  });
});
