/**
 * The MCP tools every session sees as `mcp__prifly__gcloud_*`: the generic
 * `gcloud_api` with its docs and operation waiter, and curated tools for the
 * everyday jobs. Reads run at once; every write asks the reader first
 * (`write.ts`).
 */

import type { ExtensionTool } from "@prifly/extension-api";
import type { HostApi } from "./host";
import { apiTool, realSleep, type Sleep, waitTool } from "./tools-api";
import { makeTool } from "./tools-common";
import { dnsChangeTool, dnsRecordsTool, dnsZonesTool } from "./tools-dns";
import { docsTool } from "./tools-docs";
import { logsTool } from "./tools-logs";
import { billingTool, instancesTool, projectsTool, servicesTool } from "./tools-resources";
import { connectTool, defaultProjectTool, enableApiTool, type OnChange } from "./tools-setup";

export type ToolOptions = {
  /** How `gcloud_wait_operation` waits between polls; a test passes one that does not. */
  sleep?: Sleep;
  /** The default project changed: the status line is said again. */
  onDefault?: OnChange;
  /** `gcloud_connect` finished: the status line reads Google again. */
  onConnect?: OnChange;
};

export function cloudTools(api: () => HostApi | null, options: ToolOptions = {}): ExtensionTool[] {
  const quiet = () => undefined;
  const specs = [
    apiTool,
    docsTool,
    waitTool(options.sleep ?? realSleep),
    projectsTool,
    defaultProjectTool(options.onDefault ?? quiet),
    logsTool,
    servicesTool,
    instancesTool,
    billingTool,
    enableApiTool,
    dnsZonesTool,
    dnsRecordsTool,
    dnsChangeTool,
  ];
  return [
    ...specs.map((spec) => makeTool(api, spec)),
    connectTool(api, options.onConnect ?? quiet),
  ];
}
