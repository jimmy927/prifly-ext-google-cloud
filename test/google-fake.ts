/**
 * A fake Google for the tests: routes by method and URL to an answer, and
 * Google's own error shapes (`SERVICE_DISABLED`, `IAM_PERMISSION_DENIED`,
 * 429) to answer with. Pass `fakeGoogle(routes)` as `fakeConnections`'
 * `provider`.
 */

import { CLOUD_PLATFORM } from "../scope";
import type { FakeAccount, FakeProvider } from "./fake-api";

/** One route: an HTTP method, a pattern the full URL must match, and its answer. */
export type Route = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: RegExp;
  answer: (request: Request, match: RegExpMatchArray) => Response | Promise<Response>;
};

export function fakeGoogle(routes: Route[]): FakeProvider {
  return async (request) => {
    for (const route of routes) {
      if (route.method !== undefined && route.method !== request.method) continue;
      const match = request.url.match(route.url);
      if (match !== null) return await route.answer(request, match);
    }
    return googleError(404, "NOT_FOUND", `No fake route for ${request.method} ${request.url}`);
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function googleError(
  code: number,
  status: string,
  message: string,
  details: { reason: string; metadata?: Record<string, string> }[] = [],
): Response {
  return json(
    {
      error: {
        code,
        message,
        status,
        details: details.map((detail) => ({
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          ...detail,
        })),
      },
    },
    code,
  );
}

/** What Google answers when the API is off in the project. */
export function serviceDisabled(service: string, project: string): Response {
  return googleError(
    403,
    "PERMISSION_DENIED",
    `${service} has not been used in project ${project} before or it is disabled.`,
    [
      {
        reason: "SERVICE_DISABLED",
        metadata: {
          service,
          consumer: `projects/${project}`,
          activationUrl: `https://console.developers.google.com/apis/api/${service}/overview?project=${project}`,
        },
      },
    ],
  );
}

/** What Google answers when the account lacks a permission. */
export function permissionDenied(permission: string): Response {
  return googleError(403, "PERMISSION_DENIED", `Permission '${permission}' denied on resource.`, [
    { reason: "IAM_PERMISSION_DENIED", metadata: { permission } },
  ]);
}

export function rateLimited(retryAfter = 30): Response {
  return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), {
    status: 429,
    headers: { "retry-after": String(retryAfter) },
  });
}

/** The reader's account, connected for Cloud. */
export const CLOUD_ACCOUNT: FakeAccount = {
  id: "google-1",
  provider: "google",
  account: "reader@example.com",
  scopes: ["openid", "email", CLOUD_PLATFORM],
};

/** The same account connected for Gmail only: Cloud needs incremental consent. */
export const GMAIL_ONLY_ACCOUNT: FakeAccount = {
  id: "google-1",
  provider: "google",
  account: "reader@example.com",
  scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
};
