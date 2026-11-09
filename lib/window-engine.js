import { windowOverview } from './session-state.js';
import { textContent, clip } from './text.js';
import { HANDOFF_PATHS } from './handoff-note.js';
import { translator } from './locale.js';

/** Characters of each recent user instruction quoted verbatim in the handoff. */
const USER_QUOTE_CHARS = 1000;
/** Longest escaped form of the window record's gist. The record is rendered as
 * JSON inside the header, so the gist is bounded by its ESCAPED length: otherwise
 * a reply full of backslashes would inflate the record and eat the handoff body. */
const RECORD_GIST_ESCAPED_MAX = 1200;
/** The gist never shrinks below this, so the record keeps reporting something. */
const RECORD_GIST_FLOOR = 200;

/** The record's gist, clipped by escaped length rather than by source characters. */
function recordGist(text) {
  let budget = 1000;
  let gist = clip(text, budget);
  for (let guard = 0; guard < 6 && budget > RECORD_GIST_FLOOR; guard++) {
    const escaped = JSON.stringify(gist).length;
    if (escaped <= RECORD_GIST_ESCAPED_MAX) break;
    budget = Math.max(RECORD_GIST_FLOOR, Math.floor(budget * RECORD_GIST_ESCAPED_MAX / escaped) - 40);
    gist = clip(text, budget);
  }
  return gist;
}

/** Build the window message appended after a committed DSH compaction. The
 * native checkpoint already carries the summary; this message adds the session
 * state a summary cannot replace, and its record is what advances the directory. */
export class WindowEngine {
  constructor(states, getLocale) { this.states = states; this.getLocale = getLocale; }

  /**
   * @param summary - the committed `compaction/summary` event.
   */
  prepare(session, maxChars = 8000, summary) {
    const t = translator(this.getLocale?.() ?? 'en');
    const state = this.states.get(session);
    const outgoing = state.windows.at(-1);
    const previousWindowId = outgoing.window_id;
    const newWindowId = `win_${String(state.windows.length + 1).padStart(3, '0')}`;
    const { data } = summary;
    const text = (textContent(data.rawOutput) || textContent(data.summary)).trim();
    const record = {
      version: 3, window_id: previousWindowId, compaction_id: data.compactionId,
      through_seq: Math.max(...data.shadowedSeqs),
      summary_kind: 'generated',
      summary: recordGist(text || windowOverview(outgoing)),
    };
    const sections = [
      `<context_window id="${newWindowId}" previous_window_id="${previousWindowId}">`,
      `<window_record>${JSON.stringify(record)}</window_record>`,
      t('handoff.rotated', { seq: summary.seq, provider: data.provider, model: data.model, previous: previousWindowId }),
    ];
    const footer = t('handoff.footer');
    let remaining = maxChars - sections.join('\n').length - footer.length - 40;
    const add = text => {
      if (remaining < 80) return;
      const part = clip(text, remaining - 2);
      sections.push(part); remaining -= part.length + 2;
    };
    if (state.goal) add(t('handoff.goal', { seq: state.goalSeq, phase: state.goal.phase, objective: clip(state.goal.objective, 700) }));
    else add(t('handoff.noGoal'));
    if (Array.isArray(state.todos) && state.todos.length) {
      const pending = state.todos.filter(item => item.status !== 'completed');
      const items = clip(pending.map(item => `- [${item.status}] ${item.content}`).join('\n') || t('handoff.allDone'), 700);
      add(t('handoff.checklist', { seq: state.todoSeq, total: state.todos.length, done: state.todos.length - pending.length, items }));
    } else add(t('handoff.checklistEmpty'));
    if (state.latestUsers.length) {
      add(t('handoff.recent') + '\n' + state.latestUsers.map(item => `[item_${item.seq}] ${clip(textContent(session.eventAt(item.seq).data.content), USER_QUOTE_CHARS)}`).join('\n'));
    }
    const files = [...state.notes.files.entries()].filter(([path]) => !HANDOFF_PATHS.has(path)).sort(([, x], [, y]) => y.updated_at.localeCompare(x.updated_at)).slice(0, 4);
    for (const [path, note] of files) {
      if (remaining < 150) break;
      add(t('handoff.note', { path, window: note.window_id ?? t('handoff.unknownWindow'), content: clip(note.content, Math.min(800, remaining - 100)) }));
    }
    sections.push(footer, '</context_window>');
    return { previousWindowId, newWindowId, header: sections.join('\n'), record };
  }
}
