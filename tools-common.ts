/**
 * What every `gcloud_*` tool does first: find the Google connection in good
 * standing (never signing in from a tool), and the project to read. A tool
 * then only builds its request and words the answer.
 */

import type { ExtensionConnectionsApi, ExtensionTool } from "@prifly/extension-api";
import { type Failure, sayFailure } from "./google";
import type { HostApi, ToolContext } from "./host";
import { sayStanding, standing } from "./scope";
import { readChosen } from "./settings";

export const NO_PROJECT =
  "No project given and no default project chosen: pass `project`, or the reader picks a default in the Google Cloud panel.";

/** What a tool body gets once the reader is signed in and a project is known. */
export type Ready = {
  api: HostApi;
  connections: ExtensionConnectionsApi;
  connection: string;
  /** "" for a tool that reads no single project (`gcloud_projects`). */
  project: string;
  ctx: ToolContext;
};

export type ToolSpec = {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  /** Whether the tool reads one project (and so takes the `project` argument). */
  perProject: boolean;
  run: (ready: Ready, args: Record<string, unknown>) => Promise<string>;
};

const PROJECT_PROPERTY = {
  type: "string",
  description:
    "Project id. Left out, the default project the reader chose in the Google Cloud panel.",
};

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function makeTool(apiOf: () => HostApi | null, spec: ToolSpec): ExtensionTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object",
      properties: spec.perProject
        ? { project: PROJECT_PROPERTY, ...spec.properties }
        : spec.properties,
      additionalProperties: false,
    },
    async call(args, ctx) {
      const api = apiOf();
      if (api === null) return "The Google Cloud extension is not ready yet; try again shortly.";
      const state = standing(api.connections);
      const refusal = sayStanding(state);
      if (refusal !== null) return refusal;
      if (state.kind !== "ok" || api.connections === undefined) return "No Google connection.";
      const project = spec.perProject
        ? (stringArg(args, "project") ?? readChosen(api.folder).defaultProject)
        : "";
      if (spec.perProject && project === "") return NO_PROJECT;
      const ready = { api, connections: api.connections, connection: state.connection.id };
      return await spec.run({ ...ready, project, ctx }, args);
    },
  };
}

/** Unwrap a `Result` into either its value or the failure's one sentence. */
export function orSentence<T>(answer: { ok: T } | Failure): { value: T } | { sentence: string } {
  return "ok" in answer ? { value: answer.ok } : { sentence: sayFailure(answer) };
}

export function lastSegment(path: string | undefined): string {
  if (path === undefined) return "";
  return path.split("/").pop() ?? "";
}
