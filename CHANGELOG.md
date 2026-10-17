# Changelog

## 0.4.0

- **Compaction is native again in every preset.** The `./compaction` engine subclass is gone, and so are `scripts/sync-presets.mjs` and the preset copies it kept in the profile patch. DSH upgrades no longer need a sync step, and presets you add yourself are covered automatically.
- After each committed DSH compaction, the plugin appends a window message (goal, todos, recent instructions, notes, window index) that opens the next window. It goes out on a microtask after `compaction/end`, so an overflow retry already carries it. The summary itself is DSH's checkpoint, unclipped.
- `new_context` asks the caller's own preset engine, found through `agentPresets.serviceFor()`, for one forced compaction.
- Removed `handoffSummary` (a stored value is ignored) and the priority clipping of the summary body. `handoffMaxChars` now bounds only the window message: default 8000, range 4000–32000.
- Preflight: new *preset compaction* and *legacy preset overrides* checks replace the hook, web-preset, preset-ownership and rival-engine checks.
- Upgrading: delete the `context-management preset overrides` block from the profile patch (see the README).

- Disabling context management while a `new_context` request is pending now tells the model that the requested window will not be created, instead of dropping the request silently.
- Internal: one notes tool module (the unused second copy of every tool definition is gone), shared paging and bounds helpers, declarative history schemas and one tools-enabled check. The tool schemas the model sees are byte-identical.
- Tests mount the JSONL session backend through its plugin, so the suite runs on DSH 0.2.1-alpha.3 and later.
