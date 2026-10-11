/**
 * What the reader chose: the projects the board shows and the default
 * project, picked on the board and kept in `state.json` beside the extension
 * (the api has no way for an extension to write its own settings), and the
 * poll interval, a setting of the Extensions dialog.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionApi } from "@prifly/extension-api";

export type Chosen = {
  /** The projects the board shows, in the reader's order. */
  projects: string[];
  /** The project a tool reads when the session names none; "" for none chosen. */
  defaultProject: string;
};

export const DEFAULT_POLL_MINUTES = 5;

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

export function pollMinutes(api: Pick<ExtensionApi, "settings">): number {
  const value = api.settings?.["pollMinutes"];
  return typeof value === "number" && value >= 1 ? value : DEFAULT_POLL_MINUTES;
}
