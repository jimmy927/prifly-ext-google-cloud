## Google Cloud

Use the `gcloud_*` tools for Google Cloud, not the gcloud CLI. They act as the reader's own Google account.

- Use a curated tool when one fits: `gcloud_projects`, `gcloud_logs`, `gcloud_services` (Cloud Run), `gcloud_instances`, `gcloud_billing`, `gcloud_enable_api`, `gcloud_dns_zones`, `gcloud_dns_records`, `gcloud_dns_change`.
- For anything else, call `gcloud_api_docs` first to find the method, path and body, then `gcloud_api`.
- Every write (any call that is not a GET) shows the reader a confirm card first. "Not done: you cancelled" means they said no: do not try again unless they ask.
- A long-running operation comes back as it is; follow it with `gcloud_wait_operation`.
- Without `project`, tools use the default project; `gcloud_default_project` sets it.
- If a tool says Google Cloud is not connected, ask the reader, then call `gcloud_connect`.
