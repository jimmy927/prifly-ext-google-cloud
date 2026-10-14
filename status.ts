/**
 * The extension's one line in Settings → Extensions (`api.status`):
 * "Connected · 7 projects · default shop-prod", or why it is not connected.
 * Google is asked for the project count at most every 15 minutes; a change of
 * default project is said at once from the count already in hand.
 */

import { sayFailure } from "./google";
import type { HostApi } from "./host";
import { listProjects } from "./projects";
import { standing } from "./scope";
import { readChosen } from "./settings";

export const STATUS_EVERY_MS = 15 * 60 * 1000;

export type StatusLine = {
  /** Read Google again (at activation, on the timer, after `gcloud_connect`); never rejects. */
  refresh: () => Promise<void>;
  /** Say the line again from what is in hand (after the default project changed). */
  redraw: () => void;
  stop: () => void;
};

function notConnected(api: HostApi): string | null {
  const state = standing(api.connections);
  switch (state.kind) {
    case "ok":
      return null;
    case "no-api":
      return "Not connected: this prifly has no Google connections";
    case "no-account":
      return "Not connected: no Google account";
    case "no-scope":
      return `Not connected: ${state.connection.account} is not allowed for Google Cloud`;
    case "needs-sign-in":
      return `Needs sign-in: ${state.connection.account}`;
  }
}

/** Runs `tick` every `ms` until the returned stop is called; a test passes one it drives itself. */
export type Every = (tick: () => void, ms: number) => () => void;

const realEvery: Every = (tick, ms) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export function startStatus(api: HostApi, every: Every = realEvery): StatusLine {
  let projects: string | null = null;
  let stopped = false;

  const say = (text: string): void => {
    if (!stopped) api.status?.(text);
  };

  const redraw = (): void => {
    const why = notConnected(api);
    if (why !== null) {
      say(why);
      return;
    }
    const chosen = readChosen(api.folder).defaultProject;
    const parts = [
      "Connected",
      projects ?? "reading projects…",
      chosen === "" ? "no default project" : `default ${chosen}`,
    ];
    say(parts.join(" · "));
  };

  const refresh = async (): Promise<void> => {
    const state = standing(api.connections);
    if (state.kind === "ok" && api.connections !== undefined) {
      const answer = await listProjects(api.connections, state.connection.id);
      if ("ok" in answer) {
        projects = `${answer.ok.length} project${answer.ok.length === 1 ? "" : "s"}`;
      } else {
        projects = "projects unreadable";
        api.log("status_projects_failed", { message: sayFailure(answer) });
      }
    }
    redraw();
  };

  /** `refresh` that never rejects: a failure is a line in the host's log. */
  const tick = (): Promise<void> =>
    refresh().catch((error: unknown) => {
      api.log("status_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  const stopTimer = every(() => void tick(), STATUS_EVERY_MS);
  void tick();
  return {
    refresh: tick,
    redraw,
    stop: () => {
      stopped = true;
      stopTimer();
    },
  };
}
