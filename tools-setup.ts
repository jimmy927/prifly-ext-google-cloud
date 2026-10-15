/**
 * `gcloud_enable_api` (Service Usage enable/disable, confirmed),
 * `gcloud_default_project` (the project tools read when none is named; kept
 * in `state.json`), and `gcloud_connect` (asks for the `cloud-platform`
 * scope in the reader's browser).
 */

import type { ExtensionTool } from "@prifly/extension-api";
import type { HostApi } from "./host";
import { operationState, waitHint } from "./operations";
import { allowCloud } from "./scope";
import { readChosen, writeChosen } from "./settings";
import {
  NOT_A_PROJECT_ID,
  orSentence,
  PROJECT_ID,
  type Ready,
  stringArg,
  type ToolSpec,
} from "./tools-common";
import { confirmedSend } from "./write";

// ---- enable / disable an API

/** `dns`, `dns.googleapis.com` → `dns.googleapis.com`; null for anything else. */
function serviceId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const name = value.trim().toLowerCase();
  const full = name.includes(".") ? name : `${name}.googleapis.com`;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]+$/.test(full) ? full : null;
}

async function runEnable(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const service = serviceId(stringArg(args, "service"));
  if (service === null) return "Give `service`, e.g. dns.googleapis.com.";
  const disable = args["disable"] === true;
  const verb = disable ? "disable" : "enable";
  const url = `https://serviceusage.googleapis.com/v1/projects/${ready.project}/services/${service}:${verb}`;
  const answer = await confirmedSend(ready, {
    method: "POST",
    url,
    body: disable ? { disableDependentServices: false } : {},
    project: ready.project,
    title: disable ? "Disable a Google Cloud API" : "Enable a Google Cloud API",
    summary: `${disable ? "Disable" : "Enable"} the ${service} API in project ${ready.project}.`,
    content: `API: ${service}\nProject: ${ready.project}\nAction: ${disable ? "Disable" : "Enable"}`,
  });
  if ("cancelled" in answer) return answer.cancelled;
  const result = orSentence(answer);
  if ("sentence" in result) return result.sentence;
  const state = operationState(result.value.body);
  if (state.kind === "failed") return `Could not ${verb} ${service}: ${state.message}`;
  if (state.kind === "running") {
    return `Asked to ${verb} ${service} in ${ready.project}; Google is still working on it.${waitHint(result.value.body, url)}`;
  }
  return `${disable ? "Disabled" : "Enabled"} ${service} in ${ready.project}.`;
}

export const enableApiTool: ToolSpec = {
  name: "gcloud_enable_api",
  description:
    "Enable (or, with disable: true, disable) a Google Cloud API in a project through Service Usage. Shows the reader a confirm card first; nothing changes if they cancel.",
  perProject: true,
  properties: {
    service: { type: "string", description: "The API, e.g. dns.googleapis.com or dns." },
    disable: { type: "boolean", description: "true to disable instead. Default false." },
  },
  run: runEnable,
};

// ---- default project

/** Told after the default project or the connection changed, so the status line follows. */
export type OnChange = () => void;

export function defaultProjectTool(onChange: OnChange): ToolSpec {
  return {
    name: "gcloud_default_project",
    description:
      "Set the default Google Cloud project: the one every gcloud_* tool uses when no `project` is given. Changes only this extension's own setting, nothing in Google Cloud.",
    perProject: false,
    properties: {
      project: { type: "string", description: "The project id (gcloud_projects lists them)." },
    },
    run: async (ready, args) => {
      const project = stringArg(args, "project");
      if (project === undefined) return "Give `project`.";
      if (!PROJECT_ID.test(project)) return NOT_A_PROJECT_ID;
      writeChosen(ready.api.folder, { ...readChosen(ready.api.folder), defaultProject: project });
      onChange();
      return `The default project is now ${project}.`;
    },
  };
}

// ---- connect

/**
 * Not a `ToolSpec`: it runs before the connection is in good standing, which
 * is what every other tool needs first.
 */
export function connectTool(apiOf: () => HostApi | null, onChange: OnChange): ExtensionTool {
  return {
    name: "gcloud_connect",
    description:
      "Connect Google Cloud: opens Google's consent page in the reader's browser to allow the cloud-platform scope on their Google account (or sign in again). Call it only when the reader asks, or agrees after a tool said Google Cloud is not connected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async call() {
      const api = apiOf();
      if (api === null) return "The Google Cloud extension is not ready yet; try again shortly.";
      const answer = await allowCloud(api.connections);
      onChange();
      return answer.ok
        ? `Connected: ${answer.account} can now use Google Cloud.`
        : `Not connected: ${answer.message}`;
    },
  };
}
