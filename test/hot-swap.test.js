import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, user } from './helpers/dsh.js';

const signal = () => new AbortController().signal;
/** Distinctive text of the plugin's own system-prompt section. */
const PROMPT_MARKER = 'Use session-private notes for durable facts on long tasks.';

/** Apply the host plugin the way a hot swap does: a fresh module evaluation
 * registers everything again on the same Cordis context. */
async function applyHost(ctx, config = {}) {
  const module = await import('../lib/index.js');
  let api;
  const fiber = ctx.plugin({ ...module.default, apply(child, cfg) { api = module.apply(child, cfg); } }, config);
  await fiber.await();
  return { fiber, api };
}

test('the host plugin hot-swaps: unload removes every registration and re-apply restores exactly one', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent(); const s = a.session;
  const tools = () => f.ctx.tools.schemas().length;
  const commandNames = () => f.ctx.commands.list(a).map(command => command.name);
  const promptSections = async () => JSON.stringify(await f.ctx.systemPrompt.assemble({})).split(PROMPT_MARKER).length - 1;

  await f.plugin.states.writeNote(s, 'durable.md', 'survives a reload');
  assert.equal(tools(), 10);
  assert.deepEqual(commandNames().filter(n => n === 'ctx'), ['ctx']);
  assert.equal(await promptSections(), 1);

  // Two swaps: a leak would double a registration, and a stale layer would throw
  // on the duplicate prompt section the second time round.
  for (const cycle of [1, 2]) {
    await f.fiber.dispose();
    assert.equal(tools(), 0, `cycle ${cycle}: tools leaked`);
    assert.equal(commandNames().includes('ctx'), false, `cycle ${cycle}: command leaked`);
    assert.equal(await promptSections(), 0, `cycle ${cycle}: prompt section leaked`);
    assert.equal((await f.execute(a, 'notes_read_file', { path: 'durable.md' })).isError, true);
    ({ fiber: f.fiber } = await applyHost(f.ctx));
  }

  assert.equal(tools(), 10, 'tool count must not double');
  assert.deepEqual(commandNames().filter(n => n === 'ctx'), ['ctx'], 'command must not double');
  assert.equal(await promptSections(), 1, 'prompt section must not double');
  // Notes are rebuilt from their durable store, not from the dead instance.
  const note = await f.execute(a, 'notes_read_file', { path: 'durable.md' });
  assert.equal(note.isError, false);
  assert.equal(note.value.content, 'survives a reload');
});

test('a reloaded host announces windows for the untouched native engine', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent(); const s = a.session;
  user(s, 'old work '.repeat(6000)); user(s, 'latest instruction');

  // The engine and the host are separate mount rows; swap only the host.
  await f.fiber.dispose();
  const swapped = await applyHost(f.ctx);
  f.fiber = swapped.fiber;
  assert.notEqual(swapped.api.states, f.plugin.states, 'the swap must publish a fresh store');
  assert.equal(swapped.api.states.get(s).windows.length, 1);

  assert.ok(await f.native.compactNow(a, signal()));
  await swapped.api.handoffWrites;
  const state = swapped.api.states.get(s);
  assert.equal(state.windows.at(-1).window_id, 'win_002');
  assert.equal(state.windows[0].summary_kind, 'generated');
  assert.match(state.notes.readFile('self', 'handoff.md').content, /^# Latest handoff: win_001 → win_002/);
  // One host, one window message: the unloaded instance left no listener behind.
  assert.equal(s.snapshotEvents().filter(e => e.data.source?.kind === 'plugin:context-management').length, 1);
});

test('the native engine keeps compacting on its own while the host is absent', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent(); const s = a.session;
  user(s, 'old work '.repeat(6000)); user(s, 'latest instruction');
  await f.fiber.dispose();
  assert.ok(await f.native.compactNow(a, signal()));
  await Promise.resolve();
  assert.equal(f.legacyCalls, 1);
  assert.equal(s.snapshotEvents().at(-1).type, 'compaction/end', 'no window message without the host');
});
