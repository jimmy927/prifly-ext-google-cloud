/**
 * What a picked error group starts. Stub: filled in by the board writer.
 */

import type { Launch } from "@prifly/extension-api";
import type { HostApi } from "./host";

export async function launchOf(
  _api: HostApi,
  _key: string,
  _input: string,
  _how: { again: boolean },
): Promise<Launch> {
  return { prompt: "", message: "Not built yet." };
}

export function launchedOf(_api: HostApi, _key: string, _sessionId: string): void {}
