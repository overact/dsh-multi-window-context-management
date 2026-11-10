import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, user } from './helpers/dsh.js';

const signal = () => new AbortController().signal;

test('notes and history tools stay hidden until the first window rotation', async t => {
  const f = await fixture({ config: { lazyTools: true } }); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  const visible = async () => {
    const toolSet = await f.ctx.tools.resolve({ agent, signal: signal() });
    return [...toolSet.view(agent).keys()].sort();
  };
  assert.deepEqual(await visible(), ['new_context'], 'only new_context is offered before a rotation');
  user(s, 'Implement CSV support.\n' + 'diagnostic data '.repeat(6000));
  user(s, 'Cancel CSV; implement YAML only.');
  assert.ok(await f.native.compactNow(agent, signal()));
  assert.deepEqual(await visible(), ['history_read', 'history_search', 'new_context', 'notes_read', 'notes_write']);
  // The hidden tools are still registered globally, so a reload cannot leak a second copy.
  assert.equal(f.ctx.tools.schemas().length, 5);
});

test('lazyTools applies to a live settings change', async t => {
  const f = await fixture({ config: { lazyTools: true } }); t.after(f.dispose);
  const agent = await f.agent();
  const visible = async () => {
    const toolSet = await f.ctx.tools.resolve({ agent, signal: signal() });
    return [...toolSet.view(agent).keys()].sort();
  };
  assert.deepEqual(await visible(), ['new_context'], 'lazyTools on hides notes/history');
  await f.ctx.settings.update('context-management', { lazyTools: false });
  assert.deepEqual(await visible(), ['history_read', 'history_search', 'new_context', 'notes_read', 'notes_write'],
    'turning lazyTools off must expose the full surface without a reload');
  await f.ctx.settings.update('context-management', { lazyTools: true });
  assert.deepEqual(await visible(), ['new_context'], 'turning it back on must restore the gate');
});
