/**
 * `gcloud_api_docs`: an API's own reference, from its Google discovery
 * document, trimmed to what a session needs to make the call — each method's
 * HTTP method, path, parameters and request body. The version and the
 * document's URL come from the Discovery directory when not given, so a
 * changed API is read fresh rather than built into the extension.
 */

import { gfetch, googleUrl } from "./google";
import { serviceName } from "./tools-api";
import { orSentence, type Ready, stringArg, type ToolSpec } from "./tools-common";

const DIRECTORY = "https://discovery.googleapis.com/discovery/v1/apis";
/** Methods written out in full; the rest of the matches are listed one line each. */
const MAX_DETAILED = 12;
const MAX_CHARS = 16_000;
const MAX_LISTED = 400;
const MAX_DESCRIPTION = 160;
const MAX_NESTED = 6;

type Parameter = {
  type?: string;
  location?: string;
  required?: boolean;
  repeated?: boolean;
  description?: string;
  enum?: string[];
};

type Method = {
  id?: string;
  httpMethod?: string;
  path?: string;
  flatPath?: string;
  description?: string;
  parameters?: Record<string, Parameter>;
  request?: { $ref?: string };
  response?: { $ref?: string };
};

type Resource = { methods?: Record<string, Method>; resources?: Record<string, Resource> };

type Property = {
  type?: string;
  $ref?: string;
  items?: Property;
  additionalProperties?: Property;
  description?: string;
  readOnly?: boolean;
  enum?: string[];
};

type Schema = { type?: string; properties?: Record<string, Property>; description?: string };

export type Discovery = Resource & {
  name?: string;
  title?: string;
  version?: string;
  rootUrl?: string;
  servicePath?: string;
  schemas?: Record<string, Schema>;
};

type DirectoryItem = {
  name?: string;
  version?: string;
  preferred?: boolean;
  discoveryRestUrl?: string;
};

/** Discovery documents read in this run, by URL: they change rarely and are large. */
const cache = new Map<string, Discovery>();

export function clearDocsCache(): void {
  cache.clear();
}

function short(text: string | undefined, max = MAX_DESCRIPTION): string {
  if (text === undefined) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

/** The discovery document's URL: from the directory, or the service's own `$discovery`. */
async function documentUrl(
  ready: Ready,
  service: string,
  version: string | undefined,
): Promise<{ url: string } | { sentence: string }> {
  const listing = new URL(DIRECTORY);
  listing.searchParams.set("name", service);
  const answer = orSentence(
    await gfetch<{ items?: DirectoryItem[] }>(
      ready.connections,
      ready.connection,
      listing.toString(),
    ),
  );
  const items = "value" in answer ? (answer.value.items ?? []) : [];
  const pick =
    version === undefined
      ? (items.find((each) => each.preferred) ?? items.at(-1))
      : items.find((each) => each.version === version);
  const listed = pick?.discoveryRestUrl;
  if (listed !== undefined && googleUrl(listed) !== null) return { url: listed };
  if (version !== undefined) {
    return {
      url: `https://${service}.googleapis.com/$discovery/rest?version=${encodeURIComponent(version)}`,
    };
  }
  if ("sentence" in answer) return answer;
  return {
    sentence: `The Discovery directory lists no API named "${service}". Use the name before .googleapis.com (dns, run, compute, serviceusage, cloudresourcemanager), or give \`version\`.`,
  };
}

async function readDocument(ready: Ready, url: string): Promise<Discovery | { sentence: string }> {
  const kept = cache.get(url);
  if (kept !== undefined) return kept;
  const answer = orSentence(await gfetch<Discovery>(ready.connections, ready.connection, url));
  if ("sentence" in answer) return answer;
  cache.set(url, answer.value);
  return answer.value;
}

function allMethods(resource: Resource): Method[] {
  const own = Object.values(resource.methods ?? {});
  const nested = Object.values(resource.resources ?? {}).flatMap(allMethods);
  return [...own, ...nested];
}

function pathOf(doc: Discovery, method: Method): string {
  return `${doc.servicePath ?? ""}${method.flatPath ?? method.path ?? ""}`;
}

function typeOf(property: Property): string {
  if (property.$ref !== undefined) return property.$ref;
  if (property.type === "array" && property.items !== undefined)
    return `${typeOf(property.items)}[]`;
  if (property.type === "object" && property.additionalProperties !== undefined) {
    return `map<string, ${typeOf(property.additionalProperties)}>`;
  }
  return property.type ?? "any";
}

function refOf(property: Property): string | undefined {
  return property.$ref ?? property.items?.$ref ?? property.additionalProperties?.$ref;
}

function outputOnly(property: Property): boolean {
  return property.readOnly === true || /^\[?output only/i.test(property.description ?? "");
}

/** One schema's settable fields on one line, and the schemas they name. */
function schemaLine(name: string, schema: Schema | undefined): { line: string; refs: string[] } {
  if (schema === undefined) return { line: `${name}: (not in the document)`, refs: [] };
  const fields = Object.entries(schema.properties ?? {}).filter(([, each]) => !outputOnly(each));
  if (fields.length === 0) return { line: `${name}: ${schema.type ?? "object"}`, refs: [] };
  const parts = fields.map(([field, each]) => {
    const values = each.enum === undefined ? "" : ` (${each.enum.slice(0, 8).join("|")})`;
    return `${field} ${typeOf(each)}${values}`;
  });
  const refs = fields.map(([, each]) => refOf(each)).filter((ref): ref is string => !!ref);
  return { line: `${name}: ${parts.join("; ")}`, refs };
}

/** The request schema and, one level down, the schemas it names. */
function requestLines(doc: Discovery, ref: string): string[] {
  const schemas = doc.schemas ?? {};
  const top = schemaLine(ref, schemas[ref]);
  const lines = [`  request ${top.line}`];
  const nested = [...new Set(top.refs)].filter((name) => name !== ref).slice(0, MAX_NESTED);
  for (const name of nested) lines.push(`    ${schemaLine(name, schemas[name]).line}`);
  return lines;
}

function parameterLine(name: string, parameter: Parameter): string {
  const flags = [
    parameter.location,
    parameter.required ? "required" : "",
    parameter.repeated ? "repeated" : "",
  ]
    .filter((flag) => flag)
    .join(", ");
  const values = parameter.enum === undefined ? "" : ` (${parameter.enum.slice(0, 8).join("|")})`;
  const about = short(parameter.description, 100);
  return `    ${name} (${flags}) ${parameter.type ?? "string"}${values}${about ? ` — ${about}` : ""}`;
}

function methodBlock(doc: Discovery, method: Method): string {
  const lines = [`${method.id ?? "?"} — ${method.httpMethod ?? "GET"} ${pathOf(doc, method)}`];
  const about = short(method.description);
  if (about !== "") lines.push(`  ${about}`);
  const parameters = Object.entries(method.parameters ?? {});
  if (parameters.length > 0) {
    lines.push("  parameters:");
    for (const [name, parameter] of parameters) lines.push(parameterLine(name, parameter));
  }
  if (method.request?.$ref !== undefined) lines.push(...requestLines(doc, method.request.$ref));
  if (method.response?.$ref !== undefined) lines.push(`  response ${method.response.$ref}`);
  return lines.join("\n");
}

function methodLine(doc: Discovery, method: Method): string {
  return `${method.id ?? "?"} — ${method.httpMethod ?? "GET"} ${pathOf(doc, method)}`;
}

function matches(doc: Discovery, method: Method, filter: string): boolean {
  const wanted = filter.toLowerCase();
  return [method.id, pathOf(doc, method), method.description]
    .filter((part): part is string => part !== undefined)
    .some((part) => part.toLowerCase().includes(wanted));
}

function cap(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n(Cut at ${MAX_CHARS} characters: narrow \`method\`.)`;
}

function header(doc: Discovery): string {
  // The paths below already start with `servicePath` (`pathOf`), so the base is `rootUrl` alone.
  return [
    `${doc.title ?? doc.name ?? "API"} ${doc.version ?? ""}`.trim(),
    `Base URL: ${doc.rootUrl ?? ""} — call gcloud_api with url = base URL + the path below (fill in the {placeholders}), or service "${doc.name ?? "?"}" and path = the path below as printed.`,
  ].join("\n");
}

/** One schema, every field with its description, output-only ones marked. */
function schemaDocs(doc: Discovery, name: string): string {
  const found = doc.schemas?.[name];
  if (found === undefined) return `No schema named ${name}.`;
  const lines = [schemaLine(name, found).line];
  for (const [field, each] of Object.entries(found.properties ?? {})) {
    const about = short(each.description, 140);
    const mark = outputOnly(each) ? " (output only)" : "";
    lines.push(`  ${field} ${typeOf(each)}${mark}${about ? ` — ${about}` : ""}`);
  }
  return lines.join("\n");
}

function methodList(doc: Discovery, methods: Method[]): string {
  const listed = methods.slice(0, MAX_LISTED).map((each) => methodLine(doc, each));
  const more =
    methods.length > MAX_LISTED
      ? `\n(${methods.length - MAX_LISTED} more methods: give \`method\` to narrow.)`
      : "";
  return `${methods.length} methods. Give \`method\` (e.g. "create" or a resource name) for parameters and request bodies.\n\n${listed.join("\n")}${more}`;
}

function matchingMethods(doc: Discovery, methods: Method[], filter: string): string {
  const found = methods.filter((each) => matches(doc, each, filter));
  if (found.length === 0) {
    return `No method matches "${filter}". Leave out \`method\` to list them all.`;
  }
  const detailed = found.slice(0, MAX_DETAILED).map((each) => methodBlock(doc, each));
  const rest = found.slice(MAX_DETAILED).map((each) => methodLine(doc, each));
  const tail =
    rest.length > 0 ? `\n\nAlso matching (narrow \`method\` for detail):\n${rest.join("\n")}` : "";
  return `${detailed.join("\n\n")}${tail}`;
}

/** The trimmed reference: a header, then the matching methods (or all, one line each), or one schema. */
export function trimDocs(doc: Discovery, filter: string | undefined, schema?: string): string {
  const body =
    schema !== undefined
      ? schemaDocs(doc, schema)
      : filter === undefined
        ? methodList(doc, allMethods(doc))
        : matchingMethods(doc, allMethods(doc), filter);
  return cap(`${header(doc)}\n\n${body}`);
}

async function runDocs(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const service = serviceName(stringArg(args, "service") ?? "");
  if (service === null) return "Give `service`: the API's name before .googleapis.com, e.g. dns.";
  const version = stringArg(args, "version");
  const where = await documentUrl(ready, service, version);
  if ("sentence" in where) return where.sentence;
  const doc = await readDocument(ready, where.url);
  if ("sentence" in doc) return doc.sentence;
  return trimDocs(doc, stringArg(args, "method"), stringArg(args, "schema"));
}

export const docsTool: ToolSpec = {
  name: "gcloud_api_docs",
  description:
    "Look up a Google Cloud API's methods in its own discovery document: HTTP method, path, parameters and request body. Call it before gcloud_api for anything the curated gcloud_* tools do not cover. Read-only.",
  perProject: false,
  properties: {
    service: {
      type: "string",
      description: "The API's name before .googleapis.com, e.g. dns, run, compute, sqladmin, iam.",
    },
    method: {
      type: "string",
      description:
        'Only the methods whose id, path or description contain this, e.g. "changes.create" or "rrsets". Left out: every method, one line each.',
    },
    version: {
      type: "string",
      description: "The API version, e.g. v1. Default: the preferred one.",
    },
    schema: {
      type: "string",
      description: "Instead of methods: one schema's fields, e.g. ResourceRecordSet.",
    },
  },
  run: runDocs,
};
