# tools/debug

Instruments kept for reuse: one line each. Run them from the repo root.

- `jitter-trace.ts` — counts one-pixel back-and-forth steps ("reversals") of cars, shadows and the view's scroll while cars drive steadily, with no browser; compares git refs side by side: `npx tsx tools/debug/jitter-trace.ts --ref main` (`--detail`, `--show "<signal>"`, `--frames n`).
