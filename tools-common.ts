/**
 * What every `gcloud_*` tool does first: find the Google connection in good
 * standing (only `gcloud_connect` ever signs in), and the project to read. A
 * tool then only builds its request and words the answer; a write goes
 * through `write.ts`, which asks the reader first.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionConnectionsApi, ExtensionTool } from "@prifly/extension-api";
import { type Failure, sayFailure } from "./google";
import type { HostApi, ToolContext } from "./host";
import { sayStanding, standing } from "./scope";
import { readChosen } from "./settings";

export const NO_PROJECT =
  "No project given and no default project set: pass `project`, or set the default with gcloud_default_project (gcloud_projects lists them).";

/** A Google project id, legacy domain-scoped ids included. */
export const PROJECT_ID = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export const NOT_A_PROJECT_ID =
  "That `project` is not a Google Cloud project id (lower-case letters, digits and hyphens, 6-30 characters).";

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
  description: "Project id. Left out, the default project (gcloud_default_project sets it).",
};

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The project to read (argument, else the reader's default), or why none. */
export function projectOf(
  api: HostApi,
  args: Record<string, unknown>,
): { id: string } | { refusal: string } {
  const id = stringArg(args, "project") ?? readChosen(api.folder).defaultProject;
  if (id === undefined || id === "") return { refusal: NO_PROJECT };
  return PROJECT_ID.test(id) ? { id } : { refusal: NOT_A_PROJECT_ID };
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
      const project = spec.perProject ? projectOf(api, args) : { id: "" };
      if ("refusal" in project) return project.refusal;
      const ready = { api, connections: api.connections, connection: state.connection.id };
      return await spec.run({ ...ready, project: project.id, ctx }, args);
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

/** The most a tool answers in its own text; the rest goes to the session's scratchpad. */
export const MAX_ANSWER = 20_000;

/**
 * `text` when it fits; else its start, and the whole of it saved as
 * `<label>-<time>.txt` in the session's scratchpad (said where), or how much
 * was cut when the session has none.
 */
export function fitText(text: string, ready: Ready, label: string): string {
  if (text.length <= MAX_ANSWER) return text;
  const head = text.slice(0, MAX_ANSWER);
  const cut = text.length - MAX_ANSWER;
  const scratchpad = scratchpadOf(ready.ctx);
  if (scratchpad === undefined) {
    return `${head}\n(${cut} more characters cut: the answer was too long and this session has no scratchpad. Ask for less: a filter, fields or a smaller page.)`;
  }
  mkdirSync(scratchpad, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(scratchpad, `${label.replace(/[^a-z0-9-]/gi, "-")}-${stamp}.txt`);
  writeFileSync(file, text);
  return `${head}\n(${cut} more characters cut: the whole answer is in ${file})`;
}

/** `ctx.scratchpad`, which throws on a prifly that cannot find the session's folder. */
function scratchpadOf(ctx: ToolContext): string | undefined {
  try {
    return ctx.scratchpad;
  } catch {
    return undefined;
  }
}
