/**
 * What the panel `cloud` asks for at `api/<path>`. Stub: filled in by the panel writer.
 */

import type { PanelRequest } from "@prifly/extension-api";
import type { HostApi } from "./host";

export async function panelAnswer(_api: HostApi, request: PanelRequest): Promise<unknown> {
  throw new Error(`Nothing at api/${request.path}`);
}
