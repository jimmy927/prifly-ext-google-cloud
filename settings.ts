/**
 * The default project — the one a tool reads when the session names none —
 * kept in `state.json` beside the extension and set with
 * `gcloud_default_project`. `projects` is what an older version's board
 * kept; a file from then still reads, its first project the default.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Chosen = {
  /** The projects an older version's board showed, in the reader's order. */
  projects: string[];
  /** The project a tool reads when the session names none; "" for none chosen. */
  defaultProject: string;
};

const NOTHING_CHOSEN: Chosen = { projects: [], defaultProject: "" };

function stateFile(folder: string): string {
  return join(folder, "state.json");
}

/** The reader's choice; nothing chosen when the file is missing or unreadable. */
export function readChosen(folder: string): Chosen {
  const file = stateFile(folder);
  if (!existsSync(file)) return NOTHING_CHOSEN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return NOTHING_CHOSEN;
    throw error;
  }
  return chosenOf(parsed);
}

/** Tolerant on read: a field that is not what it should be counts as unset. */
export function chosenOf(value: unknown): Chosen {
  if (typeof value !== "object" || value === null) return NOTHING_CHOSEN;
  const record = value as Record<string, unknown>;
  const projects = Array.isArray(record["projects"])
    ? [...new Set(record["projects"].filter((each): each is string => typeof each === "string"))]
    : [];
  const preferred = typeof record["defaultProject"] === "string" ? record["defaultProject"] : "";
  return { projects, defaultProject: preferred !== "" ? preferred : (projects[0] ?? "") };
}

/** Write the choice whole; a reader never sees half a file. */
export function writeChosen(folder: string, chosen: Chosen): void {
  const file = stateFile(folder);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(chosen, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
