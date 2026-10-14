/**
 * The one road for a call that changes something in Google Cloud: every
 * non-GET request a tool makes goes through `confirmedSend`, which shows the
 * reader a confirm card (`api.confirm`) with the method, the URL and the body,
 * and sends nothing unless they press Confirm.
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
  /** What will happen, in a line: "Add A www.example.com. → 1.2.3.4 in zone example". */
  summary: string;
};

/** The card's monospace block: exactly the request that goes out. */
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
  const yes = await confirm({
    title: write.title,
    summary: write.summary,
    details: requestText(write.method, write.url, write.body),
  });
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
