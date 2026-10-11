/**
 * The Google Cloud extension: what prifly imports. `activate` registers the
 * read-only `gcloud_*` tools and starts the Error Reporting poller; the other
 * exports answer the launcher `error` (`choices`, `launch`, `launched`); it
 * puts nothing in the status bar and declares no panel. Types come from
 * `@prifly/extension-api` with `import type`, so nothing of it is loaded at run time.
 */

import type { Launch, LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import { boardOf } from "./board";
import { restoreChips } from "./errors-launched";
import type { HostApi } from "./host";
import { launchedOf, launchOf } from "./launch";
import { startPoller } from "./poll";
import { cloudTools } from "./tools";

let api: HostApi | null = null;

function live(): HostApi {
  if (api === null) throw new Error("The Google Cloud extension is not running.");
  return api;
}

export function activate(given: HostApi): () => void {
  api = given;
  given.tools?.register(cloudTools(() => api));
  const stopPolling = startPoller(given);
  restoreChips(given);
  given.log("activated", {});
  return () => {
    stopPolling();
    api = null;
  };
}

/** The launcher `error`: the error groups of the chosen projects, from the poller's cache. */
export function choices(_launchId: string, query: string): LaunchBoard | LaunchChoice[] {
  return boardOf(live(), query);
}

/** The session a picked error group starts — or, for a setup row, what it did. */
export function launch(
  _launchId: string,
  key: string,
  input: string,
  how: { again: boolean },
): Promise<Launch> {
  return launchOf(live(), key, input, how);
}

/** Which session a launch became, so the card tints and the session gets its chip. */
export function launched(_launchId: string, key: string, sessionId: string): void {
  launchedOf(live(), key, sessionId);
}
