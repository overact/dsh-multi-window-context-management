import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, user } from './helpers/dsh.js';
import { SessionStateStore } from '../lib/session-state.js';
import { WindowEngine } from '../lib/window-engine.js';
import { resolveLocale, translator, description, EN, ZH } from '../lib/locale.js';

/** A committed `compaction/summary` as DSH writes it. */
function summaryEvent(text = 'Native summary.', seq = 99) {
  return { seq, data: { compactionId: 'c-1', shadowedSeqs: [0, 1, 2], summary: [{ type: 'text', text }], rawOutput: [{ type: 'text', text }], provider: 'p', model: 'm' } };
}

test('translator follows the locale and falls back to English', () => {
  assert.equal(translator('zh')('command.ctx'), ZH['command.ctx']);
  assert.equal(translator('en')('command.ctx'), EN['command.ctx']);
  assert.equal(translator('ja')('command.ctx'), EN['command.ctx']);
  assert.equal(translator('zh')('missing.key'), 'missing.key');
  assert.equal(
    translator('en')('handoff.checklist', { seq: 1, total: 2, done: 1, items: '- [x] a' }),
    'Session checklist [item_1]: 2 items, 1 completed.\n- [x] a',
  );
});

test('resolveLocale reads the DSH locale preference', () => {
  const ctx = preference => ({ settings: { describe: () => [{ ns: 'locale', value: { preference } }] } });
  assert.equal(resolveLocale(ctx('zh')), 'zh');
  assert.equal(resolveLocale(ctx('en')), 'en');
  assert.equal(resolveLocale(ctx(undefined)), 'en');
  assert.equal(resolveLocale({ settings: { describe: () => { throw new Error('no settings'); } } }), 'en');
});

test('schema descriptions carry both languages', () => {
  assert.deepEqual(description('config.enabled'), { en: EN['config.enabled'], zh: ZH['config.enabled'] });
});

test('the window message follows the active locale', () => {
  const s = Session.create('locale'), states = new SessionStateStore();
  for (let i = 0; i < 3; i++) user(s, `User ${i}`);
  const zh = new WindowEngine(states, () => 'zh').prepare(s, 16000, summaryEvent('摘要'));
  assert.match(zh.header, /窗口已换：压缩摘要/);
  assert.match(zh.header, /Goal\/todo 是持久会话状态/);
  assert.match(zh.header, /近期用户指令（按时间顺序）：/);
  const en = new WindowEngine(states, () => 'en').prepare(s, 16000, summaryEvent('summary'));
  assert.match(en.header, /Window rotated: the compaction summary/);
  assert.match(en.header, /Goal\/todo are durable session state/);
});
