# prifly-ext-google-cloud

A prifly extension: Google Cloud from any session, in place of the gcloud
CLI. You ask in plain words ("add an A record for www pointing at 1.2.3.4",
"why is the api service failing") and the session does it through the
`gcloud_*` tools, as your own Google account.

- Reads run at once. Every write (any call that is not a GET) first shows a
  confirm card: one sentence on what will happen, the record or API in plain
  text, and the method, URL and JSON body folded under Details; Cancel sends nothing and the
  tool answers "Not done: you cancelled".
- No launcher, board, chip or panel. The one thing it shows is a status line
  in Settings → Extensions: "Connected · 7 projects · default shop-prod",
  read again at most every 15 minutes.
- The session instructions it adds to every session are `prompt.md`.

## Tools

| Tool | What it does |
|---|---|
| `gcloud_api` | Any Google Cloud REST call (`https://*.googleapis.com` only): method, `url` or `service` + `path`, `query`, `body`. A long-running operation is returned as is |
| `gcloud_api_docs` | An API's methods from its discovery document: HTTP method, path, parameters, request body |
| `gcloud_wait_operation` | Polls an operation (URL, selfLink or name) until done or the time is up |
| `gcloud_projects`, `gcloud_default_project` | The projects the account sees; the default project tools use |
| `gcloud_logs`, `gcloud_services`, `gcloud_instances`, `gcloud_billing` | Cloud Logging entries, Cloud Run services, VMs, the billing link |
| `gcloud_enable_api` | Enable or disable an API in a project (Service Usage) — confirmed |
| `gcloud_dns_zones`, `gcloud_dns_records` | Cloud DNS zones and record sets |
| `gcloud_dns_change` | Create, replace or delete a record set via `changes.create` — confirmed |
| `gcloud_connect` | Asks for the `cloud-platform` scope in the reader's browser |

Google's errors (an API not enabled, a missing permission, 404) come back as
a sentence, not a failure of the tool.

## Checks

`bun test`, `bun run typecheck` and `bun run check` (biome).

## What is where

| File | What it is |
|---|---|
| `prifly-extension.json` | The manifest: the Google connection (`cloud-platform`) and the `prompt` |
| `prompt.md` | The session instructions |
| `index.ts` | What prifly imports: `activate(api)` registers the tools and starts the status line |
| `tools.ts`, `tools-*.ts` | The tools; `tools-common.ts` is what each does first |
| `write.ts` | The one road for a write: the confirm card, then the request |
| `operations.ts` | Long-running operations: whether one is done, where to poll it |
| `status.ts` | The status line |
| `scope.ts`, `settings.ts`, `projects.ts` | Which connection is used, the default project (`state.json`), the project list |
| `google.ts` | The only file that talks to Google, through `api.connections.fetch` |
| `test/` | Tests against a fake `api` and a fake Google |

Import prifly's types with `import type`: they are erased, so the host never
needs the package to run the extension.

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release.

Pull requests are welcome. Before one can be merged, its author signs the contributor agreement (`CLA.md`), which assigns the copyright in the contribution to The Startup Factory AB; the CLA bot asks for it on the pull request.
