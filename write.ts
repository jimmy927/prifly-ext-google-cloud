/**
 * The one road for a call that changes something in Google Cloud: every
 * non-GET request a tool makes goes through `confirmedSend`, which shows the
 * reader a confirm card (`api.confirm`) and sends nothing unless they press
 * Confirm. The card reads top down: one plain sentence (`summary`), what is
 * being changed in plain text (`content`), and only under a closed "Details"
 * toggle the request itself (`details`: method, URL, JSON body).
 */

import { type GoogleCall, gsend, type Method, type Result, type Sent } from "./google";
import type { Ready } from "./tools-common";

export const CANCELLED = "Not done: you cancelled";

export const NO_CONFIRM =
  "Not done: this prifly cannot show a confirm card, so the extension makes no changes. Update prifly.";

export type Write = {
  method: Exclude<Method, "GET">;
  url: string;
  body?: unknown;
  /** For `x-goog-user-project`. */
  project?: string;
  /** The card's title, a few words: "Add a DNS record". */
  title: string;
  /** One plain sentence, no URL or JSON: "Add an A record for www.example.com. pointing to 1.2.3.4 in zone example." */
  summary: string;
  /** The human part in plain text: the record, the API or the resource being changed. */
  content?: string;
};

/** The card's Details block: exactly the request that goes out. */
export function requestText(method: string, url: string, body: unknown): string {
  const head = `${method} ${url}`;
  return body === undefined ? head : `${head}\n\n${JSON.stringify(body, null, 2)}`;
}

/**
 * Ask the reader, then send. `{ cancelled }` carries the sentence for the
 * session when nothing was sent.
 */
export async function confirmedSend(
  ready: Ready,
  write: Write,
): Promise<Result<Sent> | { cancelled: string }> {
  const confirm = ready.api.confirm;
  if (confirm === undefined) return { cancelled: NO_CONFIRM };
  let yes: boolean;
  try {
    yes = await confirm({
      title: write.title,
      summary: write.summary,
      ...(write.content === undefined ? {} : { content: write.content }),
      details: requestText(write.method, write.url, write.body),
    });
  } catch (error) {
    // No answer from the card is no consent: nothing is sent, and the session is told why.
    const message = error instanceof Error ? error.message : String(error);
    ready.api.log("confirm_failed", { method: write.method, url: write.url, message });
    return { cancelled: `Not done: the confirm card could not be shown (${message})` };
  }
  if (!yes) {
    ready.api.log("write_cancelled", { method: write.method, url: write.url });
    return { cancelled: CANCELLED };
  }
  ready.api.log("write", { method: write.method, url: write.url });
  const call: GoogleCall = {
    method: write.method,
    ...(write.body === undefined ? {} : { body: write.body }),
    ...(write.project === undefined ? {} : { project: write.project }),
  };
  return await gsend(ready.connections, ready.connection, write.url, call);
}
