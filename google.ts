/**
 * The only file that talks to Google. Every call goes through prifly's
 * `api.connections.fetch`, so prifly holds the token and adds it; the answer
 * comes back as a `Result` a tool, the board and the panel can each turn into
 * words, rather than a status code each of them reads its own way.
 *
 * `project` is passed on as the fetch's `{ project }`: prifly sets
 * `x-goog-user-project` from it, so quota and billing go to the project being
 * read (decision 5: no fixed quota project in v1).
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

export type GoogleCall = {
  /** Default GET; a body makes it a JSON POST unless `method` says otherwise. */
  method?: "GET" | "POST";
  body?: unknown;
  /** The Cloud project the call is about, for `x-goog-user-project`. */
  project?: string;
};

/** Google's error body, as far as this extension reads it. */
type GoogleError = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { reason?: string; metadata?: Record<string, string> }[];
  };
};

export async function gfetch<T>(
  connections: ExtensionConnectionsApi,
  connection: string,
  url: string,
  call: GoogleCall = {},
): Promise<Result<T>> {
  const hasBody = call.body !== undefined;
  const answer = await connections.fetch(connection, url, {
    method: call.method ?? (hasBody ? "POST" : "GET"),
    ...(hasBody
      ? { body: JSON.stringify(call.body), headers: { "content-type": "application/json" } }
      : {}),
    ...(call.project === undefined ? {} : { project: call.project }),
  });
  if ("needsSignIn" in answer) {
    const { connection: id, account } = answer.needsSignIn;
    return { needsSignIn: { connection: id, account } };
  }
  if (answer.ok) return { ok: (await answer.json()) as T };
  return failureOf(answer, call.project ?? "");
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
    return JSON.parse(text) as GoogleError;
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
    return `Needs sign-in: Google ended the grant for ${failure.needsSignIn.account}. The reader clicks "Sign in again" in prifly (status bar, or Vault → Connections). Do not retry until then.`;
  }
  if ("apiDisabled" in failure) {
    const { service, project, enableUrl } = failure.apiDisabled;
    return `The ${service || "API"} is not enabled in project ${project}. Someone with access enables it at ${enableUrl}; do not retry until then.`;
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
