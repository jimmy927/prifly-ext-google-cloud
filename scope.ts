/**
 * Which Google connection the extension reads Cloud with.
 *
 * The plan was `cloud-platform.read-only` first. Google's discovery documents
 * (read 2026-10-11) say Error Reporting accepts only `cloud-platform`, and
 * Compute, Cloud Run and Cloud Billing do not accept `cloud-platform.read-only`
 * at all (each has its own `*.readonly` scope instead). So, as decided for a
 * refusal, the extension asks for `cloud-platform`; it still changes nothing,
 * since v1 has no write tools.
 *
 * The scope is asked for only from a click — the panel's "Allow Google Cloud"
 * or the board's row — as incremental consent on an account the reader
 * already connected, never from a tool call a session makes.
 */

import type { ExtensionConnection, ExtensionConnectionsApi } from "@prifly/extension-api";

export const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

/** Where the reader stands with Google, for the panel, the board and the tools. */
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
      return 'No Google account is connected. The reader clicks "Allow Google Cloud" in the Google Cloud panel.';
    case "no-scope":
      return `${state.connection.account} is connected, but not for Google Cloud. The reader clicks "Allow Google Cloud" in the Google Cloud panel. Do not retry until then.`;
    case "needs-sign-in":
      return `Needs sign-in: Google ended the grant for ${state.connection.account}. The reader clicks "Sign in again" in prifly. Do not retry until then.`;
  }
}

/**
 * Ask for `cloud-platform`: on the account the reader connected already
 * when there is one (incremental consent, also how an ended grant is
 * revived), else a new Google account.
 */
export async function allowCloud(
  connections: ExtensionConnectionsApi | undefined,
): Promise<{ ok: true; account: string } | { ok: false; message: string }> {
  if (connections === undefined) return { ok: false, message: "This prifly has no connections." };
  const state = standing(connections);
  const options =
    state.kind === "no-scope" || state.kind === "needs-sign-in" || state.kind === "ok"
      ? { connection: state.connection.id }
      : undefined;
  const answer = await connections.signIn("google", [CLOUD_PLATFORM], options);
  return answer.ok ? { ok: true, account: answer.account } : answer;
}
