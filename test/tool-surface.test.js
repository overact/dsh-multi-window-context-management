import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/dsh.js';
import { NOTES_TOOLS } from '../lib/tools/notes.js';
import { historyToolDefinitions } from '../lib/tools/history.js';
import { newContextToolDefinition } from '../lib/tools/new-context.js';

test('only five tools are exposed, with a smaller model-facing schema and no aliases', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent();
  const definitions = [newContextToolDefinition, ...Object.values(NOTES_TOOLS), ...historyToolDefinitions];
  assert.deepEqual(f.ctx.tools.schemas().map(tool => tool.name).sort(), ['history_read', 'history_search', 'new_context', 'notes_read', 'notes_write']);
  const size = JSON.stringify(definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))).length;
  assert.ok(size < 5500, `Tool definitions grew to ${size} characters (old surface: 7824 excluding group separators).`);
  for (const name of ['notes_write_file', 'notes_append_to_file', 'notes_read_file', 'notes_list_files_by_prefix', 'notes_search_contents', 'history_list_windows', 'history_list_items', 'history_read_item', 'history_search_contents']) {
    assert.equal((await f.execute(a, name)).isError, true, name);
  }
});

test('notes merge reads and discovery but require an explicit write mode', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent();
  const write = args => f.execute(a, 'notes_write', args);
  assert.equal((await write({ path: 'nested/state.md', text: 'ONE', mode: 'replace' })).isError, false);
  assert.equal((await write({ path: 'nested/state.md', text: '\nTWO', mode: 'append' })).isError, false);
  for (const mode of [undefined, 'invalid']) {
    assert.equal((await write({ path: 'nested/state.md', text: 'lost', mode })).isError, true);
  }
  assert.equal((await f.execute(a, 'notes_read', { path: 'nested/state.md' })).value.content, 'ONE\nTWO');
  const list = await f.execute(a, 'notes_read', { prefix: 'nested/' });
  assert.deepEqual(list.value.files.map(f => f.path), ['self/notes/nested/state.md']);
  const search = await f.execute(a, 'notes_read', { query: 'TWO', prefix: 'nested/' });
  assert.equal(search.value.matches[0].matches[0].line_number, 2);
  for (const args of [{ path: 'nested/state.md', query: 'TWO' }, { offset_chars: 1 }, { query: '' }, { agent_name: 'other' }]) {
    assert.equal((await f.execute(a, 'notes_read', args)).isError, true);
  }
  assert.equal((await write({ path: 'nested/state.md', text: 'other', mode: 'replace', agent_name: 'other' })).isError, true);
  assert.equal((await write({ path: 'nested/state.md', text: 'NEW', mode: 'replace' })).isError, false);
  assert.equal((await f.execute(a, 'notes_read', { path: 'nested/state.md' })).value.content, 'NEW');
});
