---
setup:
  - bun install --frozen-lockfile
---

One install, from `bun.lock`; nothing is built. The checks are `bun test`, `bun run typecheck`
(`tsc --noEmit`) and `bun run check` (biome), all straight from the source.

What it relies on outside the worktree:

- `bun` on the PATH.
- SSH access to GitHub: `@prifly/extension-api` is a git dependency,
  `git+ssh://git@github.com/jimmy927/prifly-extension-api.git#v0.1.0`, so the install clones it
  with the machine's own SSH key.

`state.json`, `launched.json` and `issues/` are written at run time by the extension itself and
are gitignored; a fresh worktree needs none of them.
