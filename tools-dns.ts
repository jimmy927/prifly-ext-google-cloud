/**
 * Cloud DNS: `gcloud_dns_zones`, `gcloud_dns_records` (reads) and
 * `gcloud_dns_change` (create, replace or delete one record set through
 * `changes.create`, its additions and deletions, after the reader confirms).
 */

import { allPages, gfetch } from "./google";
import { waitHint } from "./operations";
import { orSentence, type Ready, stringArg, type ToolSpec } from "./tools-common";
import { confirmedSend } from "./write";

const DNS = "https://dns.googleapis.com/dns/v1";

type Zone = { name?: string; dnsName?: string; visibility?: string; description?: string };
export type RecordSet = { name: string; type: string; ttl?: number; rrdatas?: string[] };
type ZonesPage = { managedZones?: Zone[]; nextPageToken?: string };
type RecordsPage = { rrsets?: RecordSet[]; nextPageToken?: string };
type Change = { id?: string; status?: string };

function zoneBase(ready: Ready, zone: string): string {
  return `${DNS}/projects/${ready.project}/managedZones/${encodeURIComponent(zone)}`;
}

/** A record set on one line: `www.example.com. A 300 1.2.3.4, 5.6.7.8`. */
function recordLine(each: RecordSet): string {
  return `${each.name} ${each.type} ${each.ttl ?? "?"} ${(each.rrdatas ?? []).join(", ")}`;
}

// ---- zones

async function runZones(ready: Ready): Promise<string> {
  const answer = orSentence(
    await allPages(
      (token) => {
        const url = new URL(`${DNS}/projects/${ready.project}/managedZones`);
        if (token !== undefined) url.searchParams.set("pageToken", token);
        return gfetch<ZonesPage>(ready.connections, ready.connection, url.toString(), {
          project: ready.project,
        });
      },
      (page: ZonesPage) => page.managedZones,
    ),
  );
  if ("sentence" in answer) return answer.sentence;
  if (answer.value.length === 0) return `No Cloud DNS zones in ${ready.project}.`;
  return answer.value
    .map((zone) =>
      [zone.name ?? "?", zone.dnsName ?? "?", zone.visibility ?? "public", zone.description ?? ""]
        .filter((part) => part !== "")
        .join(" | "),
    )
    .join("\n");
}

export const dnsZonesTool: ToolSpec = {
  name: "gcloud_dns_zones",
  description:
    "Cloud DNS managed zones of a Google Cloud project: zone name, DNS name, visibility, description. Read-only.",
  perProject: true,
  properties: {},
  run: runZones,
};

// ---- records

async function runRecords(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const zone = stringArg(args, "zone");
  if (zone === undefined) return "Give `zone`: the zone's name (gcloud_dns_zones lists them).";
  const name = stringArg(args, "name");
  const type = stringArg(args, "type")?.toUpperCase();
  if (type !== undefined && name === undefined)
    return "`type` needs `name` too (Cloud DNS filters by both).";
  let fullName: string | undefined;
  if (name !== undefined) {
    // Read the zone so a relative name (`www`, `@`) means the same as in gcloud_dns_change.
    const call = { project: ready.project };
    const found = orSentence(
      await gfetch<Zone>(ready.connections, ready.connection, zoneBase(ready, zone), call),
    );
    if ("sentence" in found) return found.sentence;
    fullName = fqdn(name, found.value.dnsName ?? "");
  }
  const answer = orSentence(
    await allPages(
      (token) => {
        const url = new URL(`${zoneBase(ready, zone)}/rrsets`);
        if (fullName !== undefined) url.searchParams.set("name", fullName);
        if (type !== undefined) url.searchParams.set("type", type);
        if (token !== undefined) url.searchParams.set("pageToken", token);
        return gfetch<RecordsPage>(ready.connections, ready.connection, url.toString(), {
          project: ready.project,
        });
      },
      (page: RecordsPage) => page.rrsets,
    ),
  );
  if ("sentence" in answer) return answer.sentence;
  if (answer.value.length === 0) return `No record sets in zone ${zone} match.`;
  return answer.value.map(recordLine).join("\n");
}

export const dnsRecordsTool: ToolSpec = {
  name: "gcloud_dns_records",
  description: "Record sets of a Cloud DNS zone, one per line: name, type, TTL, data. Read-only.",
  perProject: true,
  properties: {
    zone: { type: "string", description: "The managed zone's name (not its DNS name)." },
    name: {
      type: "string",
      description:
        "Only this DNS name: www.example.com., www (relative to the zone) or @ (the zone's apex).",
    },
    type: { type: "string", description: "With `name`: only this type, e.g. A, CNAME, TXT." },
  },
  run: runRecords,
};

// ---- change

/** A name as Cloud DNS wants it: fully qualified with the trailing dot; `@` and relative names under `zoneDns`. */
export function fqdn(name: string, zoneDns: string): string {
  const trimmed = name.trim();
  if (trimmed === "@") return zoneDns;
  if (trimmed.endsWith(".")) return trimmed;
  const absolute = `${trimmed}.`;
  if (zoneDns === "" || absolute === zoneDns || absolute.endsWith(`.${zoneDns}`)) return absolute;
  return `${trimmed}.${zoneDns}`;
}

const ACTIONS = ["create", "replace", "delete"] as const;
type Action = (typeof ACTIONS)[number];

/** The body of `changes.create`: what goes out, exactly. */
export function changeBody(
  action: Action,
  existing: RecordSet | undefined,
  wanted: RecordSet | undefined,
): { additions?: RecordSet[]; deletions?: RecordSet[] } {
  return {
    ...(action !== "create" && existing !== undefined ? { deletions: [existing] } : {}),
    ...(action !== "delete" && wanted !== undefined ? { additions: [wanted] } : {}),
  };
}

function rrdatasOf(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  if (Array.isArray(value) && value.length > 0 && value.every((each) => typeof each === "string")) {
    return value as string[];
  }
  return undefined;
}

function ttlOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 300;
}

/** "an A", "a CNAME": by how the type's first letter is said aloud. */
function withArticle(type: string): string {
  return `${/^[AEFHILMNORSX]/.test(type) ? "an" : "a"} ${type}`;
}

/** `an A record for www.example.com. pointing to 1.2.3.4`, a part of a sentence. */
function recordPhrase(each: RecordSet): string {
  const link = ["A", "AAAA", "CNAME"].includes(each.type) ? "pointing to" : "with data";
  const data = (each.rrdatas ?? []).join(", ");
  return `${withArticle(each.type)} record for ${each.name}${data === "" ? "" : ` ${link} ${data}`}`;
}

/** One plain sentence, no URL or JSON: what the change will do. */
function summaryOf(action: Action, zone: string, existing?: RecordSet, wanted?: RecordSet): string {
  if (action === "create" && wanted !== undefined)
    return `Add ${recordPhrase(wanted)} in zone ${zone}.`;
  if (action === "delete" && existing !== undefined)
    return `Delete ${recordPhrase(existing)} from zone ${zone}.`;
  return `In zone ${zone}, replace ${existing === undefined ? "?" : recordPhrase(existing)} with ${wanted === undefined ? "?" : recordPhrase(wanted)}.`;
}

function recordBlock(each: RecordSet): string {
  const values = each.rrdatas ?? [];
  return [
    `Name: ${each.name}`,
    `Type: ${each.type}`,
    `TTL: ${each.ttl ?? "?"} seconds`,
    values.length === 1
      ? `Value: ${values[0]}`
      : `Values:\n${values.map((v) => `  ${v}`).join("\n")}`,
  ].join("\n");
}

/** The card's plain-text part: the record(s) being added, deleted or replaced. */
function contentOf(action: Action, zone: string, existing?: RecordSet, wanted?: RecordSet): string {
  const parts = [`Zone: ${zone}`];
  if (action === "create" && wanted !== undefined) parts.push(`New record\n${recordBlock(wanted)}`);
  else if (action === "delete" && existing !== undefined)
    parts.push(`Record to delete\n${recordBlock(existing)}`);
  else {
    if (existing !== undefined) parts.push(`Current record (deleted)\n${recordBlock(existing)}`);
    if (wanted !== undefined) parts.push(`New record (added)\n${recordBlock(wanted)}`);
  }
  return parts.join("\n\n");
}

type ChangeInput = { action: Action; zone: string; name: string; type: string; wanted?: RecordSet };

function inputOf(args: Record<string, unknown>): ChangeInput | { refusal: string } {
  const action = stringArg(args, "action") as Action | undefined;
  if (action === undefined || !ACTIONS.includes(action))
    return { refusal: "`action` is create, replace or delete." };
  const zone = stringArg(args, "zone");
  const name = stringArg(args, "name");
  const type = stringArg(args, "type")?.toUpperCase();
  if (zone === undefined || name === undefined || type === undefined) {
    return { refusal: "Give `zone`, `name` and `type`." };
  }
  if (action === "delete") return { action, zone, name, type };
  const rrdatas = rrdatasOf(args["rrdatas"]);
  if (rrdatas === undefined)
    return { refusal: 'Give `rrdatas`: the record\'s data, e.g. ["1.2.3.4"].' };
  return { action, zone, name, type, wanted: { name, type, ttl: ttlOf(args["ttl"]), rrdatas } };
}

async function runChange(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const input = inputOf(args);
  if ("refusal" in input) return input.refusal;
  const base = zoneBase(ready, input.zone);
  const call = { project: ready.project };
  const zone = orSentence(await gfetch<Zone>(ready.connections, ready.connection, base, call));
  if ("sentence" in zone) return zone.sentence;
  const name = fqdn(input.name, zone.value.dnsName ?? "");
  const wanted = input.wanted === undefined ? undefined : { ...input.wanted, name };
  let existing: RecordSet | undefined;
  if (input.action !== "create") {
    const url = `${base}/rrsets/${encodeURIComponent(name)}/${encodeURIComponent(input.type)}`;
    const found = orSentence(
      await gfetch<RecordSet>(ready.connections, ready.connection, url, call),
    );
    if ("sentence" in found)
      return `Could not read the record set ${name} ${input.type} to change: ${found.sentence}`;
    existing = found.value;
  }
  const body = changeBody(input.action, existing, wanted);
  const url = `${base}/changes`;
  const answer = await confirmedSend(ready, {
    method: "POST",
    url,
    body,
    project: ready.project,
    title:
      input.action === "create"
        ? "Add a DNS record"
        : input.action === "delete"
          ? "Delete a DNS record"
          : "Change a DNS record",
    summary: summaryOf(input.action, input.zone, existing, wanted),
    content: contentOf(input.action, input.zone, existing, wanted),
  });
  if ("cancelled" in answer) return answer.cancelled;
  const result = orSentence(answer);
  if ("sentence" in result) return result.sentence;
  const change = result.value.body as Change;
  return `Change ${change.id ?? "?"} in zone ${input.zone}: ${change.status ?? "?"}. ${summaryOf(input.action, input.zone, existing, wanted)}${waitHint(change, url)}`;
}

export const dnsChangeTool: ToolSpec = {
  name: "gcloud_dns_change",
  description:
    "Create, replace or delete one Cloud DNS record set (name + type) through changes.create. Shows the reader a confirm card with the exact change first; nothing changes if they cancel.",
  perProject: true,
  properties: {
    action: { type: "string", enum: [...ACTIONS], description: "create, replace or delete." },
    zone: { type: "string", description: "The managed zone's name (gcloud_dns_zones lists them)." },
    name: {
      type: "string",
      description:
        "The DNS name: www.example.com., www (relative to the zone) or @ (the zone's apex).",
    },
    type: { type: "string", description: "Record type: A, AAAA, CNAME, TXT, MX, ..." },
    rrdatas: {
      type: "array",
      items: { type: "string" },
      description:
        'create/replace: the data, e.g. ["1.2.3.4"]; TXT values in quotes, e.g. ["\\"v=spf1 -all\\""].',
    },
    ttl: { type: "number", description: "create/replace: TTL in seconds. Default 300." },
  },
  run: runChange,
};
