# prifly-ext-google-cloud

A prifly extension: your Google Cloud projects, logs, VMs, Cloud Run services
and error groups, read through prifly's Google connection. Reads only.

- Read-only `gcloud_*` MCP tools (`tools*.ts`).
- One launch board, `error`: a column per chosen project, a card per open
  Error Reporting group. The board also carries the account it reads as and
  the default project, a card per project listing the APIs that are not
  enabled, and, when sign-in or consent is missing, a row that asks for it.
- No panel and nothing in the status bar: every `api.show` passes `[]`.

## Checks

`bun test`, `bun run typecheck` and `bun run check` (biome).

## What is where

| File | What it is |
|---|---|
| `prifly-extension.json` | The manifest: the Google `connections`, the `launch`er and the settings |
| `index.ts` | What prifly imports: `activate(api)` registers the tools and starts the poller; `choices`, `launch` and `launched` answer the launcher |
| `board.ts`, `launch.ts` | The board's columns and rows, and what a picked row starts or does |
| `errors-*.ts`, `poll.ts` | Error Reporting reads, the poller's cache, the APIs check, launched-card memory |
| `scope.ts`, `settings.ts`, `projects.ts` | Which connection is used, what the reader chose (`state.json`), the project list |
| `google.ts` | The only file that talks to Google, through `api.connections.fetch` |
| `test/` | Tests against a fake `api` and a fake Google |

Import prifly's types with `import type`: they are erased, so the host never
needs the package to run the extension.
