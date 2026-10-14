/**
 * `gcloud_api`: any Google Cloud REST call with the reader's `cloud-platform`
 * token — what the gcloud CLI does, by its REST API. A GET runs at once;
 * any other method asks the reader on a confirm card first (`write.ts`).
 * `gcloud_wait_operation`: follows a long-running operation until it is done.
 */

import { googleUrl, gsend, METHODS, type Method } from "./google";
import { operationState, waitHint } from "./operations";
import { readChosen } from "./settings";
import {
  fitText,
  orSentence,
  PROJECT_ID,
  type Ready,
  stringArg,
  type ToolSpec,
} from "./tools-common";
import { confirmedSend } from "./write";

const NOT_GOOGLE =
  "Refused: only https://<service>.googleapis.com URLs are called. Give a full Google API URL, or `service` (e.g. dns) and `path` (e.g. dns/v1/projects/p/managedZones).";

/** `dns`, `dns.googleapis.com` → `dns`; null for anything that is not a service name. */
export function serviceName(value: string): string | null {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/\.googleapis\.com$/, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : null;
}

type QueryValue = string | number | boolean;

function addQuery(url: URL, query: unknown): string | null {
  if (query === undefined) return null;
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return "`query` is an object of parameter names to values.";
  }
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const each of values) {
      if (!["string", "number", "boolean"].includes(typeof each)) {
        return `\`query.${key}\` must be a string, number or boolean, or a list of them.`;
      }
      url.searchParams.append(key, String(each as QueryValue));
    }
  }
  return null;
}

/** The request's URL from `url`, or `service` + `path`, plus `query`; or why not. */
export function requestUrl(args: Record<string, unknown>): { url: URL } | { refusal: string } {
  const full = stringArg(args, "url");
  const service = stringArg(args, "service");
  const path = stringArg(args, "path");
  let url: URL | null;
  if (full !== undefined) {
    url = googleUrl(full);
  } else if (service !== undefined && path !== undefined) {
    const name = serviceName(service);
    if (name === null || path.includes("://") || path.startsWith("//"))
      return { refusal: NOT_GOOGLE };
    url = googleUrl(`https://${name}.googleapis.com/${path.replace(/^\/+/, "")}`);
  } else {
    return { refusal: "Give `url`, or both `service` and `path`." };
  }
  if (url === null) return { refusal: NOT_GOOGLE };
  const bad = addQuery(url, args["query"]);
  return bad === null ? { url } : { refusal: bad };
}

/** The project quota goes to: the one the path names, else `project`, else the default. */
function quotaProject(url: URL, ready: Ready, args: Record<string, unknown>): string | undefined {
  const named = url.pathname.match(/\/projects\/([^/:]+)/)?.[1];
  if (named !== undefined && PROJECT_ID.test(named)) return named;
  const given = stringArg(args, "project");
  if (given !== undefined) return PROJECT_ID.test(given) ? given : undefined;
  const chosen = readChosen(ready.api.folder).defaultProject;
  return chosen === "" ? undefined : chosen;
}

function methodOf(value: unknown): Method | null {
  const method = typeof value === "string" ? value.trim().toUpperCase() : "GET";
  return (METHODS as readonly string[]).includes(method) ? (method as Method) : null;
}

function show(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}

async function runApi(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const method = methodOf(args["method"]);
  if (method === null) return `\`method\` is one of ${METHODS.join(", ")}.`;
  const built = requestUrl(args);
  if ("refusal" in built) return built.refusal;
  const url = built.url.toString();
  const project = quotaProject(built.url, ready, args);
  const body = args["body"];
  if (method === "GET" && body !== undefined) return "A GET takes no `body`; use `query`.";
  const answer =
    method === "GET"
      ? await gsend(ready.connections, ready.connection, url, {
          ...(project === undefined ? {} : { project }),
        })
      : await confirmedSend(ready, {
          method,
          url,
          ...(body === undefined ? {} : { body }),
          ...(project === undefined ? {} : { project }),
          title: `Google Cloud: ${method} ${built.url.hostname.replace(/\.googleapis\.com$/, "")}`,
          summary: `${method} ${built.url.hostname}${built.url.pathname}`,
        });
  if ("cancelled" in answer) return answer.cancelled;
  const result = orSentence(answer);
  if ("sentence" in result) return result.sentence;
  const text = `${result.value.status} ${method} ${url}\n${show(result.value.body)}`;
  return `${fitText(text, ready, "gcloud-api")}${waitHint(result.value.body, url)}`;
}

export const apiTool: ToolSpec = {
  name: "gcloud_api",
  description:
    "Call any Google Cloud REST API (https://*.googleapis.com) as the reader, with their cloud-platform token: what the gcloud CLI does. Give `url`, or `service` + `path`. GET runs at once; any other method shows the reader a confirm card with the request first and is not sent if they cancel. Find the method, path and body with gcloud_api_docs first. A long-running operation comes back as is; follow it with gcloud_wait_operation.",
  perProject: false,
  properties: {
    method: {
      type: "string",
      enum: [...METHODS],
      description: "HTTP method. Default GET.",
    },
    url: {
      type: "string",
      description:
        "The full URL, e.g. https://dns.googleapis.com/dns/v1/projects/my-proj/managedZones. Only *.googleapis.com.",
    },
    service: {
      type: "string",
      description:
        "Instead of `url`: the API's host name before .googleapis.com, e.g. dns, run, compute.",
    },
    path: {
      type: "string",
      description:
        "With `service`: the path after the host, e.g. dns/v1/projects/my-proj/managedZones.",
    },
    query: {
      type: "object",
      description: 'Query parameters, e.g. {"pageSize": 100, "filter": "..."}.',
    },
    body: { description: "The JSON body of a POST, PUT or PATCH." },
    project: {
      type: "string",
      description:
        "The project quota and billing go to (x-goog-user-project). Left out: the project in the path, else the default project.",
    },
  },
  run: runApi,
};

// ---- gcloud_wait_operation

const DEFAULT_WAIT_S = 120;
const MAX_WAIT_S = 600;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

function waitSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WAIT_S;
  return Math.min(MAX_WAIT_S, Math.max(1, Math.floor(value)));
}

/** The operation's URL: as given, or built from its name, `service` and `version`. */
function operationTarget(args: Record<string, unknown>): { url: string } | { refusal: string } {
  const given = stringArg(args, "operation");
  if (given === undefined) return { refusal: "Give `operation`: its URL, selfLink or name." };
  if (given.includes("://")) {
    const url = googleUrl(given);
    return url === null ? { refusal: NOT_GOOGLE } : { url: url.toString() };
  }
  const service = serviceName(stringArg(args, "service") ?? "");
  if (service === null) {
    return { refusal: "With an operation name, give `service` too (e.g. run, serviceusage)." };
  }
  const version = stringArg(args, "version") ?? "v1";
  const url = googleUrl(
    `https://${service}.googleapis.com/${version.replace(/^\/+|\/+$/g, "")}/${given.replace(/^\/+/, "")}`,
  );
  return url === null ? { refusal: NOT_GOOGLE } : { url: url.toString() };
}

export function waitTool(sleep: Sleep): ToolSpec {
  return {
    name: "gcloud_wait_operation",
    description:
      "Wait for a Google Cloud long-running operation (an Operation, a Compute operation or a Cloud DNS change) until it is done or the time is up, and say how it ended. Read-only.",
    perProject: false,
    properties: {
      operation: {
        type: "string",
        description:
          "The operation's URL or selfLink (as gcloud_api said), or its name (projects/p/locations/l/operations/x, operations/x) with `service`.",
      },
      service: { type: "string", description: "With a name: the API, e.g. run, serviceusage." },
      version: { type: "string", description: "With a name: the API version. Default v1." },
      timeoutSeconds: {
        type: "number",
        description: `How long to wait, 1-${MAX_WAIT_S}. Default ${DEFAULT_WAIT_S}.`,
      },
    },
    run: (ready, args) => runWait(ready, args, sleep),
  };
}

async function runWait(ready: Ready, args: Record<string, unknown>, sleep: Sleep): Promise<string> {
  const target = operationTarget(args);
  if ("refusal" in target) return target.refusal;
  const deadline = Date.now() + waitSeconds(args["timeoutSeconds"]) * 1000;
  const url = target.url;
  const project = quotaProject(new URL(url), ready, {});
  const call = project === undefined ? {} : { project };
  let delay = 2000;
  for (;;) {
    const answer = orSentence(await gsend(ready.connections, ready.connection, url, call));
    if ("sentence" in answer) return answer.sentence;
    const body = answer.value.body;
    const state = operationState(body);
    const shown = fitText(show(body), ready, "gcloud-operation");
    if (state.kind === "not-an-operation") return `This is not an operation:\n${shown}`;
    if (state.kind === "done") return `Done.\n${shown}`;
    if (state.kind === "failed") return `The operation failed: ${state.message}\n${shown}`;
    if (ready.ctx.signal.aborted) return "Stopped waiting: the call was cancelled.";
    if (Date.now() + delay > deadline) {
      return `Still running after the wait; call gcloud_wait_operation again with operation: "${url}".\n${shown}`;
    }
    await sleep(delay, ready.ctx.signal);
    delay = Math.min(delay * 2, 10_000);
  }
}
