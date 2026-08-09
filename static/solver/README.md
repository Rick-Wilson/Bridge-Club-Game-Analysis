# Vendored double-dummy engine

`bridge_solver_wasm.js` + `bridge_solver_wasm_bg.wasm` are copied verbatim from
the `bridge-solver` repo (`web/src/wasm/`), which is also what
solver.bridge-classroom.org ships. Same engine the `bridge-solver-service`
droplet runs, so the tables agree exactly — verified byte-for-byte against
`POST /dd` for the same deal.

| | |
|---|---|
| Source | `bridge-craftwork/bridge-solver` → `web/src/wasm/` |
| Crate version | `bridge-solver-wasm` 0.4.0 |
| Copied from commit | `2d67b7e` |
| Copied on | 2026-08-08 |

## Why vendored rather than fetched

This analyzer is a single hand-authored `index.html` with no build step, and
`build-site.sh` copies `static/` wholesale into `dist/game-analysis/`. Dropping
the two files here means the deploy needs no change at all.

## Refreshing it

```bash
cp ../bridge-solver/web/src/wasm/bridge_solver_wasm.js \
   ../bridge-solver/web/src/wasm/bridge_solver_wasm_bg.wasm \
   static/solver/
```

Then update the table above. The only export this app uses is
`Analyzer.dd_table(dealstr)`; if its return shape changes, `dd.worker.js` is the
one place that needs editing.

## Why the whole table in one call

`dd_table` solves all twenty cells in one engine call, sharing a cutoff/pattern
cache pair within each trump. Twenty separate `solve_contract` calls are roughly
twice as slow (each allocates its own caches) *and* return NS tricks rather than
per-declarer tricks, so the caller would have to redo the NS/EW conversion — a
silent-wrong-answer trap. Use `dd_table`.
