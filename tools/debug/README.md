# tools/debug

Instruments kept for reuse: one line each. Run them from the repo root.

- `jitter-trace.ts` — counts one-pixel back-and-forth steps ("reversals") of cars, shadows and the view's scroll while cars drive steadily, with no browser; compares git refs side by side: `npx tsx tools/debug/jitter-trace.ts --ref main` (`--detail`, `--show "<signal>"`, `--frames n`).
- `bake-alloc.ts` — which functions of the world's bake path allocate, in bytes per frame once warm (V8's sampling heap profiler on a lap at 430 u/s, no browser); compares git refs side by side: `npx tsx tools/debug/bake-alloc.ts --ref main` (`--no-inline` = with the compilers' inlining off, `--pin`, `--track <id>`, `--hypot` = Math.hypot against the sum world.ts spells out).
