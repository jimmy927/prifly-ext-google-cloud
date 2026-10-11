/**
 * Which card started which session, kept in `launched.json` beside the
 * extension so the board's cards stay tinted across restarts, and the chip a
 * launched session wears.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Decoration } from "@prifly/extension-api";
import { consoleUrl } from "./errors-group";
import type { HostApi } from "./host";
import { groupOf } from "./poll";

/** card key -> session id */
export type Launched = Record<string, string>;

function file(folder: string): string {
  return join(folder, "launched.json");
}

export function readLaunched(folder: string): Launched {
  if (!existsSync(file(folder))) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file(folder), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function writeLaunched(folder: string, launched: Launched): void {
  writeFileSync(`${file(folder)}.tmp`, `${JSON.stringify(launched, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file(folder)}.tmp`, file(folder));
}

/** `<project>/<groupId>` as its two parts; null for anything else. */
export function splitKey(key: string): { project: string; groupId: string } | null {
  const at = key.indexOf("/");
  if (at <= 0 || at === key.length - 1) return null;
  return { project: key.slice(0, at), groupId: key.slice(at + 1) };
}

function chipOf(key: string): Decoration | null {
  const parts = splitKey(key);
  if (parts === null) return null;
  const group = groupOf(parts.project, parts.groupId);
  return {
    key: `error:${key}`,
    icon: "cloud",
    label: `Error group · ${parts.project}`,
    tone: "info",
    details: [group?.title ?? `Error group ${parts.groupId}`],
    url: consoleUrl(parts.project, parts.groupId),
  };
}

/** Remember the launch and give every launched session still in the sidebar its chip. */
export function recordLaunch(api: HostApi, key: string, sessionId: string): void {
  const launched = { ...readLaunched(api.folder), [key]: sessionId };
  writeLaunched(api.folder, launched);
  const alive = new Set(api.sessions().map((each) => each.id));
  const bySession: Record<string, Decoration[]> = {};
  for (const [card, session] of Object.entries(launched)) {
    if (!alive.has(session)) continue;
    const chip = chipOf(card);
    if (chip !== null) bySession[session] = [...(bySession[session] ?? []), chip];
  }
  api.show(bySession, []);
}
