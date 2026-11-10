import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, user } from './helpers/dsh.js';
import { SessionStateStore } from '../lib/session-state.js';
import { WindowEngine } from '../lib/window-engine.js';
import { NotesStore } from '../lib/notes-store.js';

/** A committed `compaction/summary` as DSH writes it. */
function summaryEvent(text = 'Native summary.', seq = 99) {
  return { seq, data: { compactionId: 'c-1', shadowedSeqs: [0, 1, 2], summary: [{ type: 'text', text }], rawOutput: [{ type: 'text', text }], provider: 'p', model: 'm' } };
}

test('the window message is bounded and side-effect free', () => {
  const s = Session.create('header'), states = new SessionStateStore();
  for (let i = 0; i < 8; i++) user(s, `User ${i}: ` + 'u'.repeat(10_000));
  s.append('goal/change', { goal: { phase: 'active', objective: 'g'.repeat(20_000) } });
  s.append('todo/write', { todos: [{ content: 't'.repeat(20_000), status: 'in_progress' }] });
  for (let i = 0; i < 4; i++) states.writeNote(s, `n${i}`, 'n'.repeat(900_000));
  const seq = s.seq;
  for (const budget of [8000, 16000, 32000]) {
    const message = new WindowEngine(states).prepare(s, budget, summaryEvent('s'.repeat(50_000)));
    assert.ok(message.header.length <= budget, `${message.header.length} > ${budget}`);
    assert.ok(message.record.summary.length <= 1000);
    const recent = message.header.split('Recent user instructions (chronological):\n')[1]?.split('\nGoal/todo are durable')[0] ?? '';
    assert.match(recent, /User 7/); assert.doesNotMatch(recent, /User 0/);
    assert.equal(states.get(s).windows.length, 1); assert.equal(s.seq, seq);
  }
});

test('the window message names its summary and carries the session snapshot', () => {
  const s = Session.create('snapshot'), states = new SessionStateStore();
  for (let i = 0; i < 4; i++) user(s, `User ${i}: ` + 'u'.repeat(2_000));
  s.append('todo/write', { todos: [{ content: 'Finish YAML', status: 'in_progress' }] });
  const { header, record } = new WindowEngine(states).prepare(s, 16000, summaryEvent('## Primary Request\n' + 'g'.repeat(5_000)));
  assert.deepEqual({ ...record, summary: undefined }, { version: 3, window_id: 'win_001', compaction_id: 'c-1', through_seq: 2, summary_kind: 'generated', summary: undefined });
  assert.match(header, /^<context_window id="win_002" previous_window_id="win_001">\n<window_record>/);
  assert.match(header, /\(item_99, p\/m\)/);
  assert.doesNotMatch(header, /g{2000}/, 'the summary itself stays in the native checkpoint');
  assert.match(header, /Finish YAML/);
  // Recent instructions are quoted up to 1,000 characters each, not a 200-character topic.
  assert.match(header, /\[item_\d+\] User 3: u{970}/);
  assert.match(header, /<\/context_window>$/);
});

test('note capacity checks apply to write and append without evicting notes', () => {
  const notes = new NotesStore({ maxFiles: 2, maxTotalBytes: 10 });
  notes.appendToFile('self', 'a', 'abc'); notes.writeFile('self', 'b', 'def');
  assert.throws(() => notes.appendToFile('self', 'c', 'x'), /file limit/);
  assert.throws(() => notes.appendToFile('self', 'a', 'xxxxx'), /byte limit/);
  assert.equal(notes.readFile('self', 'a').content, 'abc');
});

test('a summary without shadowed seqs keeps a null through_seq', () => {
  const s = Session.create('empty-shadow'); const states = new SessionStateStore();
  user(s, 'hello');
  const { record } = new WindowEngine(states).prepare(s, 16000, {
    seq: 9,
    data: { compactionId: 'c-empty', shadowedSeqs: [], summary: [{ type: 'text', text: 'x' }],
      rawOutput: [{ type: 'text', text: 'x' }], provider: 'p', model: 'm' },
  });
  assert.equal(record.through_seq, null);
});
