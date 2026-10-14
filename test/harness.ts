/**
 * The tools registered on a fake api over a fake Google, with a default
 * project chosen unless left out. Folders it makes are removed by `cleanUp`
 * (call it from `afterEach`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChosen } from "../settings";
import { cloudTools } from "../tools";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import { CLOUD_ACCOUNT, fakeGoogle, type Route } from "./google-fake";

const folders: string[] = [];

export function cleanUp(): void {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
}

export function temp(): string {
  const folder = mkdtempSync(join(tmpdir(), "gcloud-tools-"));
  folders.push(folder);
  return folder;
}

export function setup(
  routes: Route[],
  options: {
    accounts?: FakeAccount[];
    defaultProject?: string | undefined;
    scratchpad?: string;
    confirm?: boolean | null;
  } = {},
) {
  const folder = temp();
  const defaultProject = "defaultProject" in options ? options.defaultProject : "shop-prod";
  if (defaultProject !== undefined) writeChosen(folder, { projects: [], defaultProject });
  const connections = fakeConnections({
    accounts: options.accounts ?? [CLOUD_ACCOUNT],
    provider: fakeGoogle(routes),
  });
  const fake = fakeApi({
    connections: connections.connections,
    folder,
    ...(options.scratchpad === undefined ? {} : { scratchpad: options.scratchpad }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
  const sleeps: number[] = [];
  fake.api.tools?.register(
    cloudTools(() => fake.api, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
  );
  return { fake, connections, sleeps };
}
