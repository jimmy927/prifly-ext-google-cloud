/**
 * Long-running operations, in the three shapes Google Cloud answers with:
 * the AIP-151 `Operation` (`name`, `done`, `error`, `response`: Run, Service
 * Usage, Resource Manager, most newer APIs), the Compute-style operation
 * (`kind: "compute#operation"`, `status: "DONE"`, `selfLink`; Cloud SQL alike)
 * and a Cloud DNS `Change` (`status: "pending" | "done"`).
 */

import { googleUrl } from "./google";

type Record_ = Record<string, unknown>;

function record(value: unknown): Record_ | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record_)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Where an answer stands, when it is an operation at all. */
export type OperationState =
  | { kind: "not-an-operation" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

function errorMessage(error: unknown): string {
  const found = record(error);
  if (found === null) return "it failed";
  const message = text(found["message"]);
  if (message !== undefined) return message;
  // Compute: `error.errors[].message`.
  const errors = Array.isArray(found["errors"]) ? found["errors"] : [];
  const messages = errors.map((each) => text(record(each)?.["message"])).filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : JSON.stringify(found);
}

function isComputeStyle(body: Record_): boolean {
  const kind = text(body["kind"]) ?? "";
  return kind.endsWith("#operation") && typeof body["status"] === "string";
}

function isOperationName(name: string | undefined): boolean {
  return name !== undefined && /(^|\/)operations\//.test(name);
}

/** A finished operation: done, or failed with its error. */
function ended(found: Record_): OperationState {
  return found["error"] === undefined
    ? { kind: "done" }
    : { kind: "failed", message: errorMessage(found["error"]) };
}

export function operationState(body: unknown): OperationState {
  const found = record(body);
  if (found === null) return { kind: "not-an-operation" };
  if (text(found["kind"]) === "dns#change") {
    return found["status"] === "done" ? { kind: "done" } : { kind: "running" };
  }
  if (isComputeStyle(found) || (text(found["selfLink"]) ?? "").includes("/operations/")) {
    return found["status"] === "DONE" ? ended(found) : { kind: "running" };
  }
  if (typeof found["done"] === "boolean" || isOperationName(text(found["name"]))) {
    return found["done"] === true ? ended(found) : { kind: "running" };
  }
  return { kind: "not-an-operation" };
}

/** The API version prefix of a Google URL's path: `/compute/v1`, `/v2`, `/dns/v1`; "" for none. */
function versionPrefix(url: URL): string {
  const segments = url.pathname.split("/");
  const at = segments.findIndex((segment) => /^v\d+[a-z0-9]*$/.test(segment));
  return at < 0 ? "" : segments.slice(0, at + 1).join("/");
}

/**
 * The URL to poll an operation `body` at, given the URL the request that
 * answered it went to; undefined when it cannot be told.
 */
export function operationUrl(body: unknown, requestUrl: string): string | undefined {
  const found = record(body);
  if (found === null) return undefined;
  const self = text(found["selfLink"]);
  if (self !== undefined && googleUrl(self) !== null) return self;
  const request = googleUrl(requestUrl);
  if (request === null) return undefined;
  if (text(found["kind"]) === "dns#change") {
    const id = text(found["id"]);
    if (id === undefined) return undefined;
    const path = request.pathname.replace(/\/changes(\/[^/]*)?$/, "/changes");
    return `${request.origin}${path}/${encodeURIComponent(id)}`;
  }
  const name = text(found["name"]);
  if (name === undefined) return undefined;
  if (googleUrl(name) !== null) return name;
  return `${request.origin}${versionPrefix(request)}/${name.replace(/^\//, "")}`;
}

/** The line that follows an answer which is an operation still running. */
export function waitHint(body: unknown, requestUrl: string): string {
  if (operationState(body).kind !== "running") return "";
  const url = operationUrl(body, requestUrl);
  const target = url === undefined ? "its name (and the service)" : `operation: "${url}"`;
  return `\nThis is a long-running operation, still running. Follow it with gcloud_wait_operation, ${target}.`;
}
