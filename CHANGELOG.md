# Changelog

## 0.7.1

- **`lazyTools` now applies to a live settings change.** The gate is read at step time (`!current.lazyTools || rotated`), so toggling it takes effect on the next tool resolution without re-registering anything; `syncTools()` now only tracks whether the tools are mounted.
- **An unreadable notes snapshot no longer blocks the session.** `NoteRepository.load()` quarantines a corrupt snapshot as `<session>.json.corrupt-<timestamp>` (kept, not deleted) and starts empty; `agent/pre-step` logs a state error instead of rejecting the step. Cancellation still propagates.
- **`through_seq` is `null` when a compaction shadows no seqs**, instead of `-Infinity` becoming `null` only by JSON serialization; the unused `summary_through_seq` window state is gone.
- **Preflight warns about a stale `@local/...` plugin name in the profile patch.** DSH skips a row whose name does not match the installed package, so that row's config silently stops applying; the check catches the rename residue.
- Both READMEs now state the peer range that `package.json` actually declares (`>=0.1.7-alpha.1 || >=0.2.0-0 <0.2.2-0 || >=0.2.2-0`).
- **Per-module design notes** live in `docs/design/` (shipped in the package) and are linked from both READMEs.

## 0.7.0

- **Renamed to `dsh-multi-window-context-management` and published to npm.** The loader entry id stays `context-management`, so `/ctx` and the saved settings keep working; a `link:` install keeps working the same way.
- Peer ranges now admit DSH 0.2.2 prereleases without `includePrerelease` (`>=0.1.7-alpha.1 || >=0.2.0-0 <0.2.2-0 || >=0.2.2-0`), and `engines.dsh` declares the same requirement for the plugin market.
- Added a 180×180 PNG tile (`assets/icon-180.png`) for the plugin market.

## 0.6.1

- **The plugin follows the DSH language.** Config descriptions, the `/ctx` command text, the system prompt section, the window handoff and the handoff note are now resolved from the host `locale` preference: English and Chinese ship with the plugin, and any other preference falls back to English. The `/ctx` command is re-registered when the language changes.
- **The settings section is editable again.** Its checkboxes checked a `mode` field that the DSH 0.2.2 config form no longer carries, so every control was disabled with "Host settings are unavailable"; the form now follows the form's `writable` flag.
- `npm run verify`: 84/84 on DSH 0.2.2-rc.1.

## 0.6.0

- **Notes and history tools appear only after the session's first window rotation.** `lazyTools` (default on) gates `notes_read`, `notes_write`, `history_search` and `history_read` per session through the tool registry's step condition; a session that never rotates carries only `new_context`'s schema (~290 characters instead of ~2,900). Set `lazyTools: false` for the old always-on surface.
- **DSH 0.2.2-rc.1 adaptation.** The test harness mounts `NativeToolExecutor` and uses the batch execution API; the settings fixture updates the config object the plugin actually received. `npm run verify`: 80/80 on DSH 0.2.2-rc.1.
- **Plugin icon** (`icon.svg`, declared as `icon` in package.json) for the plugin list.
- Tool schemas stay at ~2,868 characters and the system prompt section is shorter; the window message no longer carries the window index.

## 0.5.1

- The window message is leaner: the window index section is gone (history_search scope=windows still pages it), and the message keeps at most 4 notes of ~800 characters each instead of 8 of ~1,200. `handoffMaxChars` now defaults to 6000.
- Tool schemas are ~26% smaller (3891 → 2868 characters) with the same names, parameters and behaviour; the system prompt section is shorter too.
- Measured on 148 plugin-on sessions: fixed cost is now roughly 1k tokens per step (5 tool schemas + prompt) instead of ~1.3k, and a handoff is ~0.5k tokens smaller on average.

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
