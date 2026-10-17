import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, user, dsh, llm } from './helpers/dsh.js';
import { HistoryStore } from '../lib/history-store.js';

const signal = () => new AbortController().signal;

/** Mount the real human-facing `/compact` command over the fixture engine. */
async function withCompactCommand(f) {
  const commands = await dsh('dsh-command-compact');
  await f.ctx.plugin(commands).await();
}

/** One closed turn with a tool call, so the token meter and the compaction
 * transaction both accept the history as idle. */
function turn(session, n, output) {
  const turn = { turn: n, step: 1 };
  session.append('turn/start', { turn: n });
  session.append('step/start', turn);
  session.append('assistant/message', { ...turn, message: llm.createAssistantMessage({
    content: [{ type: 'tool-call', id: `c${n}`, name: 'bash', arguments: '{}' }],
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' });
  session.append('tool/result', { ...turn, message: llm.createToolResultMessage({
    callId: `c${n}`, content: [{ type: 'text', text: output }], isError: false,
  }) }, { surfaceOp: 'append' });
  session.append('step/end', turn);
  session.append('turn/end', { turn: n });
}

/** The auxiliary summarizer's real envelope, carrying a body the size a real one produces. */
function summarizerStub(summaryChars = 18_624) {
  return async () => {
    const summary = [{ type: 'text', text: '## Primary Request and Intent\n' + 'S'.repeat(summaryChars) }];
    return { summary, rawOutput: summary, provider: 'fixture-provider', model: 'fixture-summarizer',
      maxTokens: 4000, llmStreamCall: true, usage: { inputTokens: 20_000, outputTokens: 5_000 } };
  };
}

/** A long session whose auxiliary summary is the size a real one produces. */
async function longSession(f, { summaryChars = 18_624, summarizer } = {}) {
  const agent = await f.agent(); const s = agent.session;
  s.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture' } } });
  s.append('goal/change', { goal: { phase: 'active', objective: 'Keep the rotation honest' } });
  s.append('todo/write', { todos: [{ content: 'Verify /compact', status: 'in_progress' }] });
  await f.plugin.states.writeNote(s, 'sentinel2-task.md', 'x'.repeat(900));
  await f.plugin.states.writeNote(s, 'current-template-task.md', 'y'.repeat(900));
  user(s, 'Long first task. ' + 'noise '.repeat(9_000));
  turn(s, 1, 'output '.repeat(2_500));
  turn(s, 2, 'more output '.repeat(2_000));
  user(s, 'Now compress manually.');
  f.native.summarizer = summarizer ?? summarizerStub(summaryChars);
  return { agent, s };
}

test('manual /compact summarizes natively once and opens a window', async t => {
  const f = await fixture(); t.after(f.dispose);
  await withCompactCommand(f);
  const { agent, s } = await longSession(f);
  const meter = f.ctx.tokenMeter;
  const before = meter.measure(s).totalTokens;
  const result = await f.ctx.commands.execute(agent, '/compact', [], signal());
  await f.plugin.handoffWrites;
  assert.equal(result.result.kind, 'success');
  assert.equal(f.legacyCalls, 1, 'exactly one native summarizer call');
  assert.equal(f.plugin.states.get(s).windows.at(-1).window_id, 'win_002');
  assert.equal(f.plugin.states.get(s).windows[0].summary_kind, 'generated');
  assert.equal(f.plugin.states.get(s).notes.readFile('self', 'handoff.md').content.split('\n')[0],
    '# Latest handoff: win_001 → win_002');
  // What remains is the native summary (sized by DSH's maxTokens, ~4.6k tokens
  // here) plus the window message bounded by handoffMaxChars.
  const after = meter.measure(s).totalTokens;
  assert.ok(after < before / 3, `${after} is not well below ${before}`);
});

test('the full summary reaches the model, and the window message stays within its budget', async t => {
  const f = await fixture({ config: { handoffMaxChars: 16000 } }); t.after(f.dispose);
  await withCompactCommand(f);
  const { agent, s } = await longSession(f);
  await f.ctx.commands.execute(agent, '/compact', [], signal());
  await f.plugin.handoffWrites;
  const event = s.snapshotEvents().filter(e => e.type === 'compaction/summary').at(-1);
  // Nothing clips the summary any more: the checkpoint carries all of it.
  assert.equal(event.data.summary[0].text.length, '## Primary Request and Intent\n'.length + 18_624);
  assert.equal(event.data.provider, 'fixture-provider');
  assert.deepEqual(event.data.usage, { inputTokens: 20_000, outputTokens: 5_000 });
  const message = s.snapshotEvents().filter(e => e.data.source?.kind === 'plugin:context-management').at(-1).data.content[0].text;
  assert.ok(message.length <= 16000, `${message.length} > 16000`);
  assert.match(message, /Session goal \[item_\d+\] phase=active/);
  assert.match(message, /Session checklist \[item_\d+\]/);
  assert.match(message, /^Note self\/notes\//m);
  // The ID the window message advertises must resolve through the real tool surface.
  const read = await f.execute(agent, 'history_read_item', { item_id: `item_${event.seq}` });
  assert.equal(read.isError, false);
  assert.match(read.value.content, /^## Primary Request and Intent/);
  const history = new HistoryStore(s, f.plugin.states);
  assert.equal(history.listWindows({ recent_first: false })[0].summary_item_id, `item_${event.seq}`);
});
