import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, user, llm, fixture } from './helpers/dsh.js';
import { HistoryStore } from '../lib/history-store.js';
import { SessionStateStore } from '../lib/session-state.js';

test('history is isolated by live session, including explicit agent-name overrides', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent('a'), b = await f.agent('b');
  user(a.session, 'A private task'); user(b.session, 'B private task');
  await f.execute(a, 'notes_write', { mode: 'replace', path: 'progress.md', text: 'A state' });
  await f.execute(b, 'notes_write', { mode: 'replace', path: 'progress.md', text: 'B state' });
  const items = await f.execute(a, 'history_search');
  assert.equal(items.isError, false);
  assert.equal(items.value.items.length, 1);
  assert.match(items.value.items[0].truncated_content, /A private/);
  assert.equal((await f.execute(a, 'history_search', { agent_name: 'b' })).isError, true);
  assert.equal((await f.execute(a, 'notes_read', { path: '/b/notes/progress.md' })).isError, true);
  assert.equal((await f.execute(a, 'notes_write', { mode: 'replace', path: '/b/notes/progress.md', text: 'overwrite' })).isError, true);
  assert.equal((await f.execute(b, 'notes_read', { path: 'progress.md' })).value.content, 'B state');
});

test('event IDs remain stable through repeated rotations; older history is not evicted', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent(); const s = a.session;
  const first = user(s, 'FIRST RESULT ' + 'a'.repeat(40_000)); user(s, 'tail');
  await f.native.compactNow(a, new AbortController().signal);
  user(s, 'b'.repeat(40_000)); user(s, 'new tail');
  await f.native.compactNow(a, new AbortController().signal);
  const history = new HistoryStore(s, f.plugin.states);
  assert.equal(history.searchContents({ query: 'FIRST RESULT', window_id: 'win_001' }).matches.length, 1);
  assert.equal(history.readItem({ item_id: `item_${first.seq}`, window_id: 'win_001' }).content.slice(0, 12), 'FIRST RESULT');
  for (let i = 0; i < 2100; i++) user(s, 'later ' + i);
  assert.ok(history.readItem({ item_id: `item_${first.seq}` }));
  assert.equal(f.plugin.states.get(s).windows.length, 3);
});

test('window, goal and checklist IDs advertised in a handoff stay readable', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent(); const s = a.session;
  const goal = s.append('goal/change', { goal: { phase: 'active', objective: 'Ship the window fix' } });
  const todo = s.append('todo/write', { todos: [{ content: 'Write tests', status: 'in_progress' }] });
  user(s, 'x'.repeat(40_000)); user(s, 'latest');
  assert.ok(await f.native.compactNow(a, new AbortController().signal));
  const h = new HistoryStore(s, f.plugin.states);
  // Every handoff prints these IDs; reading one must not come back null.
  const window = h.listWindows({ recent_first: false }).windows[0];
  const summary = h.readItem({ item_id: window.summary_item_id });
  assert.ok(summary, `${window.summary_item_id} must be readable`);
  assert.equal(summary.event_type, 'compaction/summary');
  assert.equal(summary.role, 'system');
  assert.equal(summary.window_id, 'win_001');
  assert.equal(summary.content, 'Fixture native summary.');
  // JSON format still returns the complete durable record, raw output included.
  const raw = JSON.parse(h.readItem({ item_id: window.summary_item_id, format: 'json' }).content);
  assert.equal(raw.type, 'compaction/summary');
  assert.equal(raw.data.rawOutput[0].text, 'Fixture native summary.');
  assert.match(h.readItem({ item_id: `item_${goal.seq}` }).content, /Ship the window fix/);
  assert.match(h.readItem({ item_id: `item_${todo.seq}` }).content, /Write tests/);
  // Scope: the records stay out of the message-shaped listing. The goal is
  // still searchable through the window message that quotes it.
  assert.equal(h.listItems({ limit: 50 }).items.some(i => i.event_type === 'compaction/summary'), false);
  const found = h.searchContents({ query: 'Ship the window fix' });
  assert.ok(found.matches.length >= 1);
  assert.equal(found.matches[0].event_type, 'user/message');
});

test('bounded cursor scans find old matches without duplicate items or full-output search responses', () => {
  const s = Session.create('pagination');
  user(s, 'NEEDLE ' + 'x'.repeat(1_000_000));
  for (let i = 0; i < 2050; i++) s.append('assistant/chunk', { text: 'noise' });
  const h = new HistoryStore(s, new SessionStateStore());
  const page1 = h.searchContents({ query: 'NEEDLE' });
  assert.equal(page1.matches.length, 0); assert.equal(page1.scanned_events, 2000); assert.equal(page1.has_more, true);
  const page2 = h.searchContents({ query: 'NEEDLE', cursor: page1.next_cursor });
  assert.equal(page2.matches.length, 1); assert.equal(page2.has_more, false);
  assert.ok(JSON.stringify(page2).length < 2000);
  const read = h.readItem({ item_id: 'item_0' });
  assert.equal(read.content.length, 8000); assert.equal(read.next_offset_chars, 8000);
  assert.equal(h.searchContents({ query: 'needle', cursor: 0 }).matches.length, 0);
  assert.equal(h.searchContents({ query: 'needle', cursor: 0, case_sensitive: false }).matches.length, 1);
  assert.deepEqual(h.listItems({ window_id: 'missing' }).items, []);
});

test('real tool-result correlation and PTC dispatch events remain searchable and retrievable', () => {
  const s = Session.create('tools');
  s.append('assistant/message', { message: llm.createAssistantMessage({
    content: [{ type: 'tool-call', id: 'c', name: 'fs__read', arguments: '{"path":"a"}' }],
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' });
  const output = s.append('tool/result', { message: llm.createToolResultMessage({ callId: 'c', content: [{ type: 'text', text: 'EXACT RAW OUTPUT' }], isError: false }) }, { surfaceOp: 'append' });
  const ptc = s.append('tool/code-dispatch', { name: 'bash', arguments: { cmd: 'pwd' }, content: [{ type: 'text', text: 'PTC OUTPUT' }], isError: false });
  const h = new HistoryStore(s, new SessionStateStore());
  const results = h.listItems({ role: 'tool', tool_namespace: 'fs', tool_name: 'read' }).items;
  assert.equal(results.length, 1); assert.equal(results[0].item_id, `item_${output.seq}`);
  assert.equal(h.readItem({ item_id: `item_${output.seq}` }).content, 'EXACT RAW OUTPUT');
  const raw = JSON.parse(h.readItem({ item_id: `item_${ptc.seq}`, format: 'json' }).content);
  assert.equal(raw.data.arguments.cmd, 'pwd');
  assert.equal(h.searchContents({ query: 'PTC OUTPUT' }).matches.length, 1);
});

test('unchanged session projection performs zero repeat event reads', () => {
  const s = Session.create('incremental');
  for (let i = 0; i < 10000; i++) user(s, 'record ' + i);
  const states = new SessionStateStore(); states.get(s);
  let reads = 0; const eventAt = s.eventAt.bind(s);
  s.eventAt = seq => { reads++; return eventAt(seq); };
  states.get(s); assert.equal(reads, 0);
  user(s, 'tail'); states.get(s); assert.equal(reads, 1);
});

test('merged history tools browse, search and read through the real tool runtime', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent();
  const first = user(a.session, 'FIRST precise evidence');
  user(a.session, 'SECOND precise evidence');
  const listed = await f.execute(a, 'history_search', { limit: 1, recent_first: false });
  assert.equal(listed.isError, false);
  assert.equal(listed.value.items[0].item_id, `item_${first.seq}`);
  const next = await f.execute(a, 'history_search', { limit: 1, recent_first: false, cursor: listed.value.next_cursor });
  assert.match(next.value.items[0].truncated_content, /SECOND/);
  const found = await f.execute(a, 'history_search', { query: 'first', case_sensitive: false });
  assert.equal(found.value.matches.length, 1);
  const read = await f.execute(a, 'history_read', { item_id: found.value.matches[0].item_id, limit_chars: 5 });
  assert.equal(read.value.content, 'FIRST');
  const tail = await f.execute(a, 'history_read', { item_id: found.value.matches[0].item_id, offset_chars: read.value.next_offset_chars });
  assert.equal(read.value.content + tail.value.content, 'FIRST precise evidence');
  assert.equal((await f.execute(a, 'history_search', { scope: 'windows', query: 'ignored?' })).isError, true);
});

test('window directory pages past 20 windows in both directions without skipping old windows', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent();
  const state = f.plugin.states.get(a.session);
  state.windows = Array.from({ length: 55 }, (_, i) => ({ window_id: `win_${i + 1}`, start_seq: i, created_at: 0, item_count: 0 }));
  for (const recent_first of [true, false]) {
    const ids = []; let cursor;
    do {
      const result = await f.execute(a, 'history_search', { scope: 'windows', recent_first, ...(cursor === undefined ? {} : { cursor }) });
      assert.equal(result.isError, false);
      assert.ok(result.value.windows.length <= 20);
      ids.push(...result.value.windows.map(w => w.window_id));
      cursor = result.value.next_cursor;
    } while (cursor !== null);
    assert.deepEqual(ids, (recent_first ? [...state.windows].reverse() : state.windows).map(w => w.window_id));
  }
  const initial = await f.execute(a, 'history_search', { scope: 'windows', limit: 1 });
  state.windows.push({ window_id: 'win_56', start_seq: 55, created_at: 0, item_count: 0 });
  const continued = await f.execute(a, 'history_search', { scope: 'windows', limit: 1, cursor: initial.value.next_cursor });
  assert.equal(continued.value.windows[0].window_id, 'win_54');
});
