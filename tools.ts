/**
 * The read-only MCP tools every session sees as `mcp__prifly__gcloud_*`.
 * Stub: filled in by the tools writer.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import type { HostApi } from "./host";

export function cloudTools(_api: () => HostApi | null): ExtensionTool[] {
  return [];
}
