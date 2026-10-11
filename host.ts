/**
 * Parts of prifly's api newer than `@prifly/extension-api` v0.1.0, typed
 * here until the package has them: `ctx.scratchpad` (the calling session's
 * scratchpad folder, for output too long for a tool's text) and
 * `api.openUrl` (opens a link in the reader's browser). Both may be absent —
 * an older prifly — so every use has a way without them.
 */

import type { ExtensionApi, ExtensionToolContext } from "@prifly/extension-api";

export type ToolContext = ExtensionToolContext & { scratchpad?: string };

export type HostApi = ExtensionApi & { openUrl?: (url: string) => void | Promise<void> };
