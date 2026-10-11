/**
 * The project list the launcher's "Show <project> on the board" rows are made
 * from. The launcher asks for choices on every keystroke and cannot wait, so
 * the list is read once in the background and the rows say "Reading…" until
 * it lands.
 */

import type { LaunchChoice } from "@prifly/extension-api";
import { sayFailure } from "./google";
import type { HostApi } from "./host";
import { listProjects, type Project } from "./projects";

type Listing =
  | { kind: "reading"; connection: string; done: Promise<void> }
  | { kind: "done"; connection: string; projects: Project[] }
  | { kind: "failed"; connection: string; message: string };

let listing: Listing | null = null;

/** The listing for this connection, started when there is none. */
function listingOf(api: HostApi, connection: string): Listing {
  if (listing !== null && listing.connection === connection) return listing;
  const { connections } = api;
  if (connections === undefined) return { kind: "failed", connection, message: "No connections." };
  const reading: Listing = {
    kind: "reading",
    connection,
    done: listProjects(connections, connection).then((answer) => {
      listing =
        "ok" in answer
          ? { kind: "done", connection, projects: answer.ok }
          : { kind: "failed", connection, message: sayFailure(answer) };
    }),
  };
  listing = reading;
  return reading;
}

/** Forget the list, so the next rows read it again. */
export function forgetProjects(): void {
  listing = null;
}

/** Resolves when the list being read has landed (at once when none is). */
export async function projectsRead(): Promise<void> {
  if (listing?.kind === "reading") await listing.done;
}

/** How many projects the account sees; null before the list has landed. */
export function projectCount(): number | null {
  return listing?.kind === "done" ? listing.projects.length : null;
}

/** Add / remove rows for every project, or the row saying why there are none. */
export function projectRows(api: HostApi, connection: string, chosen: string[]): LaunchChoice[] {
  const found = listingOf(api, connection);
  if (found.kind === "reading") {
    return [{ key: "setup:reading", title: "Reading your projects…", tone: "muted" }];
  }
  if (found.kind === "failed") {
    return [
      { key: "setup:reload", title: found.message, detail: "Click to try again", tone: "warning" },
    ];
  }
  const known = new Set(found.projects.map((each) => each.id));
  const gone = chosen
    .filter((id) => !known.has(id))
    .map((id): Project => ({ id, name: id, state: "", parent: "" }));
  const rows = [...found.projects, ...gone]
    .filter((each) => each.state === "" || each.state === "ACTIVE" || chosen.includes(each.id))
    .map((each): LaunchChoice => {
      const on = chosen.includes(each.id);
      return {
        key: `${on ? "setup:remove" : "setup:add"}:${each.id}`,
        title: on ? `Remove ${each.id} from the board` : `Show ${each.id} on the board`,
        detail: each.name,
        tone: on ? "good" : "info",
      };
    });
  return chosen.length === 0
    ? rows
    : [...rows, { key: "setup:done", title: "Back to the board", tone: "muted" }];
}
