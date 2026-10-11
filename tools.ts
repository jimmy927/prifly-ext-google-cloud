/**
 * The read-only MCP tools every session sees as `mcp__prifly__gcloud_*`.
 * Each is a `ToolSpec` (tools-logs.ts, tools-resources.ts); there are no
 * write tools in v1.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import type { HostApi } from "./host";
import { makeTool } from "./tools-common";
import { logsTool } from "./tools-logs";
import { billingTool, instancesTool, projectsTool, servicesTool } from "./tools-resources";

export function cloudTools(api: () => HostApi | null): ExtensionTool[] {
  return [projectsTool, logsTool, instancesTool, servicesTool, billingTool].map((spec) =>
    makeTool(api, spec),
  );
}
