---
setup:
  - bun install --frozen-lockfile
---

One install, from `bun.lock`; nothing is built. The checks are `bun test`, `bun run typecheck`
(`tsc --noEmit`) and `bun run check` (biome), all straight from the source.

What it relies on outside the worktree:

- `bun` on the PATH.
- SSH access to GitHub: `@prifly/extension-api` is a git dependency,
  `git+ssh://git@github.com/jimmy927/prifly-extension-api.git#v0.6.0`, so the install clones it
  with the machine's own SSH key. If bun says "no commit matching" a tag that exists, its cached
  clone of that repository is stale: remove that clone from `~/.bun/install/cache/` and install again.

`state.json` (the default project) is written at run time by the extension itself and is
gitignored; a fresh worktree needs none of it. `launched.json` and `issues/` were an older
version's and stay ignored for installs that still have them.
