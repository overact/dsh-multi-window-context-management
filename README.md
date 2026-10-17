# dsh-context-management

**English** · [简体中文](./README.zh-CN.md)

Windowed context handoffs, session-private notes and paged history recall for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). The multi-window idea is borrowed from Codex, but this is **not a 1:1 port of the Codex API, and it does not promise lossless recovery of every detail**.

## Compatibility

Version **0.4.0**, verified on **DSH 0.2.1-rc.2 / Node.js ≥ 22.15**. Peer ranges are `>=0.1.7-alpha.1 || >=0.2.0-0`, admitting the 0.2.0 prereleases with no upper bound on stable releases: since 0.1.7-rc.1, DSH skips at startup any plugin whose peer range excludes the running version, so an upper bound would silently disable the plugin after a DSH upgrade. Compatibility is judged by capability instead, through the [preflight check](#preflight-check).

- **Compaction stays native in every preset.** The plugin never replaces, subclasses or patches DSH's compaction engine, and touches no preset. DSH upgrades need no extra step, and presets you create yourself are covered automatically.
- After each committed DSH compaction, the plugin appends one **window message**: goal, todos, the last user instructions, recent notes and the window index. That message opens the next window. The summary itself is DSH's own checkpoint, unchanged and unclipped, with its real provider/model/usage.
- `new_context` finds the engine of the caller's own preset through `agentPresets.serviceFor(agent, 'compaction')` and asks it for one forced compaction. Native tool-call pairing, retention, maintenance lock, cancellation, shrink check, transaction, persistence and overflow retry all apply unchanged.
- The window number only advances once DSH actually commits the replacement. Failures, cancellations and "nothing to compact" never report a successful switch.
- Unloading or disabling the plugin leaves native compaction exactly as DSH ships it.

## How it works

```mermaid
flowchart TD
  P["Before every agent step"] --> Q{"new_context requested?"}
  Q -- yes --> F["Ask the preset's own engine<br/>for one forced compaction"]
  Q -- no --> D["DSH's own pressure check"]
  M["Manual /compact"] --> N
  O["Provider reports context overflow"] --> N
  F --> N["DSH native compaction:<br/>one summary call, checkpoint replaces older messages"]
  D -- above threshold --> N
  N --> W["compaction/end → plugin appends the window message<br/>goal/todo + last 4 user instructions + notes + window index"]
  W --> E["Enter window win_N+1<br/>system prompt and tools unchanged"]
  W --> H["Replace handoff.md<br/>append to handoff-log.md"]
  E --> R["Model recovers exact details on demand<br/>with history_* / notes_*"]
```

A session cannot append while it is publishing an event, so the window message follows `compaction/end` on a microtask. That still runs before the compacting engine resumes, so an overflow retry already sends it. The threshold and the verbatim tail are DSH's own settings (`thresholdRatio`, `headroomTokens`, `retainRatio`), which this plugin does not change.

## Tools

| Tool | Purpose |
| --- | --- |
| `new_context` | Request a window switch at the next safe step boundary |
| `notes_write_file` / `notes_append_to_file` / `notes_read_file` / `notes_list_files_by_prefix` / `notes_search_contents` | Session-private notes that survive window switches and restarts |
| `history_list_windows` / `history_list_items` / `history_read_item` / `history_search_contents` | Paged recall over the session's complete raw history. `history_read_item` also resolves the summary, goal and checklist item IDs that every window message prints |

## Usage

`/ctx` toggles the plugin; `/compact` runs DSH's native compaction, which then opens a new window. The toggle applies to **every session of the running DSH instance**, not to a single chat tab.

When the model calls `new_context` it gets back **requested**, not a reset: the switch is scheduled for the next safe step boundary, after the current step's tool results are fully written to history. Explicit switch requests are honoured even when DSH's `auto` compaction is off. A preset with no compaction engine refuses `new_context` with a clear error, while the notes/history tools stay usable.

The web "Context management" settings page uses DSH `configForms` and shares its backend setting with `/ctx`. Read failures, read-only connections and failed saves are never shown as a successful toggle. Settings changes need no restart. Every registration goes through the Cordis lifecycle, so a hot swap (dispose + re-apply) removes all ten tools, the `/ctx` command, the prompt section and both listeners, then re-installs exactly one of each while notes are rebuilt from their durable store. DSH's `hmr` entry watches only its configured `root` directories, so add this plugin's `lib` there to reload on source edits; otherwise **reload the plugin or restart DSH, then refresh the page** after upgrading the plugin code.

## Storage and recovery

History is read straight from the caller's own immutable DSH session log:

- `item_<seq>` is a stable event address; nothing is indexed twice and old records are not dropped past 2,000 entries.
- Native tool results are linked to their names by call ID; `tool/code-dispatch` (PTC) is searchable too.
- `history_read_item` with `format: "json"` pages through complete raw events, including call arguments and metadata.
- Windows are delimited by the plugin's window messages, each tied to its compaction by a `<window_record>`. Old events kept in the retained tail still belong to the window that produced them. Sessions written by 0.3.x, whose handoff lived inside the summary, are still read.

Notes are isolated per session under `self/notes/<path>`; **there is no arbitrary cross-session read/write**. They live in the plugin's own directory, `$DSH_HOME/context-management/notes/<sessionId>.json` (`$DSH_HOME` resolved by `dsh-home-paths`), independent of the session-persistence backend's private layout, and are written with DSH's atomic write and cross-process file lock. A failed write never swaps unsaved state into the cache.

After every committed window switch (automatic, `/compact` or `new_context`) the plugin writes two notes itself: `handoff.md` is replaced with the latest full summary (the summarizer's raw output), and `handoff-log.md` gains one line with the window, time, summary item and first line. Only the latest summary is kept in full, because each one already merges the previous one; earlier ones stay readable through `history_read_item`. Neither note is injected into the window message, because the summary is already in the conversation. A cancelled or failed compaction writes nothing, and a failed note write is logged without blocking the switch.

Notes load on demand, not for every session at startup. On restore, window metadata is rebuilt and that session's notes are loaded; an unfinished transient switch request is not re-executed after a restart.

Include `context-management/notes/` when backing up or migrating; **deleting a session does not delete its notes file**. Forked sessions get independent notes; parent notes are not implicitly shared.

## Limits

| Operation | Default / hard limit |
| --- | --- |
| Window message (`handoffMaxChars`) | 8,000 characters by default, configurable 4,000–32,000; the native summary is separate and sized by DSH's own `maxTokens` |
| Injected notes | Up to the 8 most recent, ~1,200 characters each, within the message budget |
| Single note file | 1,000,000 UTF-8 bytes |
| Notes per session | 64 files / 4,000,000 UTF-8 bytes; over-limit writes are rejected, never silently evicted |
| History list / search | 20 items by default, 50 max; 400 characters per item by default, 1,000 max |
| History scan per page | Up to 2,000 events or ~2,000,000 content characters; a single large event is checked in full |
| History preview per page | Up to 12,000 characters in total, plus item metadata |
| History / note body reads | 8,000 characters by default, 20,000 max |
| Note search | Up to 10 files × 5 lines; 400 characters per line |

History queries return `has_more` and `next_cursor`; keep the same filters and order when continuing. Body reads continue with `next_offset_chars`. Search is case-sensitive unless `case_sensitive: false`.

The last four user instructions are quoted in chronological order, up to 1,000 characters each, with their event addresses, later corrections taking precedence. The window message also keeps the active goal, open todos and a bounded set of recent notes; exact raw evidence is recovered through the history tools.

## Installation

This plugin is not published to npm; the `@local/` scope marks it as a local plugin. Using the web profile as an example:

1. Clone and install dependencies:

   ```bash
   git clone https://github.com/overact/dsh-context-management.git
   cd dsh-context-management && npm install
   ```

2. Run the [preflight check](#preflight-check) to confirm the installed DSH provides every capability the plugin needs and nothing in the profile collides with it:

   ```bash
   npm run preflight -- --profile web
   ```

3. In the profile directory (`$DSH_HOME/profiles/<profile>/`), add a local link to `dependencies` in `package.json`, then run `pnpm install` there:

   ```json
   "@local/dsh-context-management": "link:<plugin-dir>"
   ```

4. Register the plugin in the profile's `cordis.patch.yml` (see Configuration below).

5. Restart DSH and refresh the page.

### Upgrading from 0.3.x

0.3.x mounted its own engine by restating the shipped presets in a generated block of the profile patch. That engine is gone, so delete the block between `# >>> context-management preset overrides` and `# <<< context-management preset overrides`, and change any remaining `@local/dsh-context-management/compaction` row back to `@deepseek-ai/dsh-compaction-basic`. Until you do, the preflight's *legacy preset overrides* check fails. The `handoffSummary` setting is gone too: a stored value is ignored, and every window now uses the native summary.

## Preflight check

`scripts/preflight.mjs` checks that the target DSH **actually provides** each capability the plugin uses, and that nothing in the profile collides with it. It **never compares version numbers**: the requirement list is extracted from the `lib/` sources (DSH imports, `ctx.<service>.<method>` calls, events, session-log event types, tool and command names), so new usages in the code are covered without touching the check.

| Check | Level | What it verifies |
| --- | --- | --- |
| DSH imports | fail | The target DSH packages really export the functions/classes the plugin imports |
| Preset compaction | fail | The native engine has `compactIfNeeded()` and the preset registry has `serviceFor()`, the two seams `new_context` uses |
| Host services | fail | The packages providing the services the plugin calls (`tools`, `sessions`, `commands`, `systemPrompt`, `settings`) have those methods |
| Host events, session-log types | fail | DSH still emits the events and session event types the plugin listens for |
| Notes storage | fail | The notes directory under `$DSH_HOME` is writable |
| Tool and command names | fail | Neither DSH itself nor another profile plugin defines a tool or command with the same name |
| Legacy preset overrides | fail | The profile patch no longer mounts the 0.3.x engine |
| Web client packages and services | warn | The client packages and `configForms`/`slots`/`locale` services behind the settings page exist; without them `/ctx` still works |

It exits with code 1 when any fail-level check fails. Running it after a DSH upgrade is optional: nothing in the profile depends on the DSH version.

## Configuration

```yaml
- insert:
    - id: context-management
      name: '@local/dsh-context-management'
      config:
        enabled: true
        overrideCompaction: true
        injectTools: true
        defaultStrategy: window      # or native: models not listed in modelPolicies get no window messages
        modelPolicies: []            # e.g. [{ provider: deepseek, model: deepseek-chat, strategy: native }]
        handoffMaxChars: 8000        # 4000–32000
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable context management for every session of this DSH instance; this is what `/ctx` toggles |
| `overrideCompaction` | `true` | Append the window message after each native compaction and open a new window |
| `injectTools` | `true` | Provide the notes/history/new_context tools; when off, compaction is purely native |
| `defaultStrategy` | `window` | Default strategy; `native` makes unlisted models compact natively without window messages |
| `modelPolicies` | `[]` | Per exact provider/model strategy overrides; the first match wins |
| `handoffMaxChars` | `8000` | Maximum characters of the window message, not counting the native summary |

`injectTools: false` removes the tools and leaves compaction purely native, so history is never trimmed without a way to recover it. `overrideCompaction: false` keeps the notes/history tools while compaction runs without window messages; `new_context` is then refused.

## Verification

```bash
npm install
npm run verify
```

Tests need the DSH dev dependency; alternatively point `DSH_PACKAGE_DIR` at an installed `@deepseek-ai/dsh` package directory. The summarizer is a fixed local fixture on DSH's real `BasicCompactionEngine`, so **the tests never call a paid model**. They run in a single-process Node test runner to avoid restarting the DSH test runtime.

Coverage includes the real Cordis lifecycle, DSH ToolRuntime, SettingsProvider, TokenMeter, BasicCompactionEngine, `/compact`, overflow recovery and JSONL disk recovery, plus web settings binding, session isolation, tool pairing, cancellation, failure paths and capacity limits. The web tests check the state/write contract; they are not a full visual browser test.

History reads are incremental: building state for 10,000 synthetic events takes ~2.5 ms the first time, and an unchanged re-read scans **0 events** (timings are indicative only; the regression tests pin incremental reads, scan limits and output limits).

0.4.0 passes 72 tests on DSH 0.2.1-rc.2, including the preflight: a stand-in DSH missing one seam must make it report exactly that capability.

## Code layout

| Module | Responsibility |
| --- | --- |
| `lib/index.js` | Host plugin: config schema, tool and command registration, compaction and pre-step listeners, settings changes |
| `lib/window-controller.js` / `window-engine.js` / `window-policy.js` | Forced rotation through the preset's engine, the window message, per-model strategy |
| `lib/handoff-note.js` | Writing `handoff.md` and `handoff-log.md` after each committed switch |
| `lib/session-state.js` | Incremental per-session state projection (windows, goal/todo, pending requests) |
| `lib/history-store.js` / `lib/tools/history.js` | Paged session-log recall and the history tools |
| `lib/notes-store.js` / `lib/note-repository.js` / `lib/tools/notes.js` | In-memory note model, locked atomic persistence, the notes tools |
| `lib/tools/new-context.js` | The `new_context` tool |
| `lib/text.js` | Message text extraction and clipping |
| `lib/client.js` | Web settings page (lazy-CJS client module) |
| `scripts/preflight.mjs` / `dsh-env.mjs` | Pre-install capability check, locating DSH and the profile |

## License

[MIT](./LICENSE)
