/**
 * The Google Cloud extension: what prifly imports. A toolbox for prompts:
 * `activate` registers the `gcloud_*` tools and keeps one status line in
 * Settings → Extensions. No launcher, board, chip or panel; nothing in the
 * status bar. The session instructions are `prompt.md` (the manifest's
 * `prompt`). Types come from `@prifly/extension-api` with `import type`, so
 * nothing of it is loaded at run time.
 */

import type { HostApi } from "./host";
import { startStatus } from "./status";
import { cloudTools } from "./tools";

export function activate(given: HostApi): () => void {
  let api: HostApi | null = given;
  const status = startStatus(given);
  given.tools?.register(
    cloudTools(() => api, {
      onDefault: status.redraw,
      onConnect: () => void status.refresh(),
    }),
  );
  given.log("activated", {});
  return () => {
    status.stop();
    api = null;
  };
}
