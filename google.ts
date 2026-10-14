/**
 * The only file that talks to Google. Every call goes through prifly's
 * `api.connections.fetch`, so prifly holds the token and adds it; the answer
 * comes back as a `Result` a tool turns into words, rather than a status code
 * each tool reads its own way. Nothing here throws for what Google answers:
 * a 403, a 404 or a refused request is a `Failure` with its sentence.
 *
 * `project` is passed on as the fetch's `{ project }`: prifly sets
 * `x-goog-user-project` from it, so quota and billing go to the project being
 * read.
 *
 * Writes are not made here directly by a tool: they go through `write.ts`,
 * which asks the reader first.
 */

import type { ExtensionConnectionsApi } from "@prifly/extension-api";

/** Why a call did not answer, in the terms a reader can act on. */
export type Failure =
  | { needsSignIn: { connection: string; account: string } }
  | { apiDisabled: { service: string; project: string; enableUrl: string } }
  | { denied: { permission: string; message: string } }
  | { rateLimited: { retryAfter: number } }
  | { failed: { status: number; message: string } };

export type Result<T> = { ok: T } | Failure;

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

export type GoogleCall = {
  /** Default GET; a body makes it a JSON POST unless `method` says otherwise. */
  method?: Method;
  body?: unknown;
  /** The Cloud project the call is about, for `x-goog-user-project`. */
  project?: string;
};

/** A successful answer: its status and its body (parsed JSON, the text when not JSON, {} when empty). */
export type Sent = { status: number; body: unknown };

/** Google's error body, as far as this extension reads it. */
type GoogleError = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { reason?: string; metadata?: Record<string, string> }[];
  };
};

/** Send one request; any answer, a refused request included, comes back as a `Result`. */
export async function gsend(
  connections: ExtensionConnectionsApi,
  connection: string,
  url: string,
  call: GoogleCall = {},
): Promise<Result<Sent>> {
  const hasBody = call.body !== undefined;
  let answer: Awaited<ReturnType<ExtensionConnectionsApi["fetch"]>>;
  try {
    answer = await connections.fetch(connection, url, {
      method: call.method ?? (hasBody ? "POST" : "GET"),
      ...(hasBody
        ? { body: JSON.stringify(call.body), headers: { "content-type": "application/json" } }
        : {}),
      ...(call.project === undefined ? {} : { project: call.project }),
    });
  } catch (error) {
    // prifly refused the request (an unknown connection, a host the token must not go to) or the network failed.
    const message = error instanceof Error ? error.message : String(error);
    return { failed: { status: 0, message: `The request was not sent: ${message}` } };
  }
  if ("needsSignIn" in answer) {
    const { connection: id, account } = answer.needsSignIn;
    return { needsSignIn: { connection: id, account } };
  }
  if (answer.ok) return { ok: { status: answer.status, body: bodyOf(await answer.text()) } };
  return failureOf(answer, call.project ?? "");
}

/** `gsend` for a call whose answer is JSON of a known shape. */
export async function gfetch<T>(
  connections: ExtensionConnectionsApi,
  connection: string,
  url: string,
  call: GoogleCall = {},
): Promise<Result<T>> {
  const answer = await gsend(connections, connection, url, call);
  return "ok" in answer ? { ok: answer.ok.body as T } : answer;
}

function bodyOf(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}

async function failureOf(answer: Response, project: string): Promise<Failure> {
  if (answer.status === 429) {
    return { rateLimited: { retryAfter: retryAfterSeconds(answer.headers.get("retry-after")) } };
  }
  const text = await answer.text();
  const parsed = parseError(text);
  const message = parsed?.error?.message ?? (text.slice(0, 300) || answer.statusText);
  const details = parsed?.error?.details ?? [];
  const disabled = details.find((detail) => detail.reason === "SERVICE_DISABLED");
  if (disabled !== undefined) {
    const service = disabled.metadata?.["service"] ?? "";
    const where = disabled.metadata?.["consumer"]?.replace(/^projects\//, "") ?? project;
    return {
      apiDisabled: {
        service,
        project: where,
        enableUrl:
          disabled.metadata?.["activationUrl"] ??
          `https://console.developers.google.com/apis/api/${service}/overview?project=${where}`,
      },
    };
  }
  if (details.some((detail) => detail.reason === "RATE_LIMIT_EXCEEDED")) {
    return { rateLimited: { retryAfter: retryAfterSeconds(answer.headers.get("retry-after")) } };
  }
  if (answer.status === 403) {
    const permission =
      details.find((detail) => detail.metadata?.["permission"] !== undefined)?.metadata?.[
        "permission"
      ] ?? "";
    return { denied: { permission, message } };
  }
  return { failed: { status: answer.status, message } };
}

function parseError(text: string): GoogleError | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as GoogleError) : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** `Retry-After` in seconds; Google sends seconds. Left out or unreadable: a minute. */
function retryAfterSeconds(header: string | null): number {
  const seconds = Number(header);
  return header !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
}

/** A failure as one sentence a session can act on without retrying blindly. */
export function sayFailure(failure: Failure): string {
  if ("needsSignIn" in failure) {
    return `Needs sign-in: Google ended the grant for ${failure.needsSignIn.account}. The reader clicks "Sign in again" in prifly (Vault → Connections), or you call gcloud_connect. Do not retry until then.`;
  }
  if ("apiDisabled" in failure) {
    const { service, project, enableUrl } = failure.apiDisabled;
    const name = service || "API";
    const how =
      service === ""
        ? `enable it at ${enableUrl}`
        : `enable it with gcloud_enable_api (service ${service}, project ${project}) if the reader agrees, or at ${enableUrl}`;
    return `The ${name} is not enabled in project ${project}: ${how}. Do not retry until then.`;
  }
  if ("denied" in failure) {
    const { permission, message } = failure.denied;
    return permission === ""
      ? `Permission denied: ${message}`
      : `Permission denied: the account lacks ${permission}. ${message}`;
  }
  if ("rateLimited" in failure) {
    return `Google rate-limited the call; try again in ${failure.rateLimited.retryAfter} s.`;
  }
  if (failure.failed.status === 0) return failure.failed.message;
  return `Google answered ${failure.failed.status}: ${failure.failed.message}`;
}

/**
 * Every page of a list call, up to `maxPages`: `nextPageToken` is added to
 * the URL (GET) or the body (POST) as Google's list methods take it.
 */
export async function allPages<T, Item>(
  fetchPage: (pageToken: string | undefined) => Promise<Result<T & { nextPageToken?: string }>>,
  itemsOf: (page: T) => Item[] | undefined,
  maxPages = 10,
): Promise<Result<Item[]>> {
  const items: Item[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const answer = await fetchPage(token);
    if (!("ok" in answer)) return answer;
    items.push(...(itemsOf(answer.ok) ?? []));
    token = answer.ok.nextPageToken;
    if (token === undefined || token === "") break;
  }
  return { ok: items };
}

/** Only `https://*.googleapis.com` URLs: anything else is refused before it is sent. */
export function googleUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  return url.hostname.endsWith(".googleapis.com") ? url : null;
}
