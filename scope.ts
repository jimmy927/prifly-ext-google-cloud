/**
 * Which Google connection the extension reads Cloud with.
 *
 * The plan was `cloud-platform.read-only` first. Google's discovery documents
 * (read 2026-10-11) say Error Reporting accepts only `cloud-platform`, and
 * Compute, Cloud Run and Cloud Billing do not accept `cloud-platform.read-only`
 * at all (each has its own `*.readonly` scope instead). The extension asks
 * for `cloud-platform`, which also covers its writes; every write still waits
 * for the reader's confirm card (`write.ts`).
 *
 * The scope is asked for only by `gcloud_connect`, as incremental consent on
 * an account the reader already connected; the reader approves it on Google's
 * own consent page in their browser.
 */

import type { ExtensionConnection, ExtensionConnectionsApi } from "@prifly/extension-api";

export const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

/**
 * How long `gcloud_connect` waits for the reader to finish Google's consent
 * page. Without a limit, a consent tab that is closed or ends on an error
 * keeps the tool call (and the session waiting on it) running forever.
 */
export const CONSENT_TIMEOUT_MS = 5 * 60_000;

/** Where the reader stands with Google, for the tools and the status line. */
export type Standing =
  | { kind: "no-api" }
  | { kind: "no-account" }
  | { kind: "no-scope"; connection: ExtensionConnection }
  | { kind: "needs-sign-in"; connection: ExtensionConnection }
  | { kind: "ok"; connection: ExtensionConnection };

/**
 * The connection to use: the first Google account with `cloud-platform`,
 * one in good standing before one that needs a sign-in; else the first
 * Google account, which only lacks the scope.
 */
export function standing(connections: ExtensionConnectionsApi | undefined): Standing {
  if (connections === undefined) return { kind: "no-api" };
  const google = connections.list("google");
  const scoped = google.filter((each) => each.scopes.includes(CLOUD_PLATFORM));
  const good = scoped.find((each) => each.state === "ok");
  if (good !== undefined) return { kind: "ok", connection: good };
  const [ended] = scoped;
  if (ended !== undefined) return { kind: "needs-sign-in", connection: ended };
  const [first] = google;
  if (first !== undefined) return { kind: "no-scope", connection: first };
  return { kind: "no-account" };
}

/** Why a tool cannot read Cloud now, or null when it can. */
export function sayStanding(state: Standing): string | null {
  switch (state.kind) {
    case "ok":
      return null;
    case "no-api":
      return "This prifly has no Google connections yet: update prifly.";
    case "no-account":
      return "No Google account is connected for Google Cloud. If the reader agrees, call gcloud_connect: it opens Google's consent page in their browser.";
    case "no-scope":
      return `${state.connection.account} is connected, but not for Google Cloud. If the reader agrees, call gcloud_connect: it opens Google's consent page in their browser. Do not retry until then.`;
    case "needs-sign-in":
      return `Needs sign-in: Google ended the grant for ${state.connection.account}. The reader clicks "Sign in again" in prifly, or you call gcloud_connect if they agree. Do not retry until then.`;
  }
}

/**
 * Ask for `cloud-platform`: on the account the reader connected already
 * when there is one (incremental consent, also how an ended grant is
 * revived), else a new Google account. Gives up after `timeoutMs` when the
 * reader never finishes the consent page.
 */
export async function allowCloud(
  connections: ExtensionConnectionsApi | undefined,
  timeoutMs = CONSENT_TIMEOUT_MS,
): Promise<{ ok: true; account: string } | { ok: false; message: string }> {
  if (connections === undefined) return { ok: false, message: "This prifly has no connections." };
  const state = standing(connections);
  const options =
    state.kind === "no-scope" || state.kind === "needs-sign-in" || state.kind === "ok"
      ? { connection: state.connection.id }
      : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ ok: false; message: string }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          message: `the consent page was not completed within ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes. Ask the reader whether to try again; do not retry on your own.`,
        }),
      timeoutMs,
    );
  });
  try {
    const answer = await Promise.race([
      connections.signIn("google", [CLOUD_PLATFORM], options),
      timedOut,
    ]);
    return answer.ok ? { ok: true, account: answer.account } : answer;
  } finally {
    clearTimeout(timer);
  }
}
