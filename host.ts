/**
 * `ctx.scratchpad` (the calling session's scratchpad folder, for output too
 * long for a tool's text) and `api.openUrl` (opens a link in the reader's
 * browser) are in `@prifly/extension-api` since v0.5.0 as always present, but
 * an older prifly lacks both, so they are typed optional here and every use
 * has a way without them. `api.confirm` and `api.status` (v0.6.0) are
 * optional in the package itself: without `confirm` no write is sent
 * (`write.ts`), and without `status` there is simply no status line.
 */

import type { ExtensionApi, ExtensionToolContext } from "@prifly/extension-api";

export type ToolContext = Omit<ExtensionToolContext, "scratchpad"> & { scratchpad?: string };

export type HostApi = Omit<ExtensionApi, "openUrl"> & { openUrl?: ExtensionApi["openUrl"] };
