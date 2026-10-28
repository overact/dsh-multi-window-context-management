import { WindowEngine } from './window-engine.js';
import { strategyFor, toolsEnabled } from './window-policy.js';
import { recordHandoff } from './handoff-note.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const SOURCE = { kind: 'plugin:context-management' };

/** Windowing on top of DSH's own compaction engine. Compaction, its summary and
 * its durable transaction stay native in every preset; this controller only
 * forces a rotation on request and, after each committed compaction, appends the
 * window message that opens the next window.
 */
export class WindowController {
  /**
   * @param ctx - the host plugin's context.
   * @param states - the session state store.
   * @param getConfig - current plugin config.
   * @param flush - persists a session.
   */
  constructor(ctx, states, getConfig, flush) {
    this.ctx = ctx;
    this.states = states;
    this.getConfig = getConfig;
    this.flush = flush;
    this.windows = new WindowEngine(states);
    this.sessionHandoffWrites = new WeakMap();
    this.handoffWrites = Promise.resolve();
    this.closed = false;
  }

  /** The host unloaded: a window message already queued must not land after it. */
  close() { this.closed = true; }

  /** The compaction engine an agent runs: its preset's isolated one when the
   * agent belongs to a preset, otherwise one in the host realm. */
  compactionFor(agent) {
    return this.ctx.get('agentPresets')?.serviceFor?.(agent, 'compaction') ?? this.ctx.get('compaction') ?? null;
  }

  active(agent) {
    const config = this.getConfig();
    return toolsEnabled(config) && config.overrideCompaction && strategyFor(agent, config) === 'window';
  }

  /** Process a model request only after its tool result and sibling results have
   * reached the log. Native overflow selection preserves a balanced recent tail.
   */
  async rotatePending(agent, signal) {
    const session = agent.session;
    const request = this.states.get(session).pending;
    if (!request) return null;
    const engine = this.compactionFor(agent);
    if (!engine) {
      this.finishPending(session, request.seq, 'This agent preset has no compaction engine; no window rotation was performed.');
      return null;
    }
    if (!this.active(agent)) {
      this.finishPending(session, request.seq, 'The current model policy uses native compaction; no window rotation was performed.');
      return null;
    }
    try {
      const result = await engine.compactIfNeeded(agent, 'context-overflow', signal);
      if (result === null) this.finishPending(session, request.seq, 'No safely reducible history yet; the current window is unchanged.');
      return result;
    } catch (error) {
      this.finishPending(session, request.seq, 'Window rotation did not complete: ' + String(error.message ?? error).slice(0, 300), !signal?.aborted);
      if (signal?.aborted) throw error;
      this.ctx.logger?.warn?.('context-management: requested rotation failed', error);
      return null;
    }
  }

  /** Called for every live `compaction/end`. A session cannot append while it
   * publishes an event, so the window message follows on a microtask: still
   * before the compacting engine resumes, so an overflow retry already sees it. */
  compactionEnded(session, event) {
    if (event.data.error) return;
    queueMicrotask(() => {
      if (this.closed) return;
      try {
        if (this.announce(session, event.data.compactionId)) this.writeHandoff(session);
      } catch (error) {
        this.ctx.logger?.warn?.('context-management: window message was not appended', error);
      }
    });
  }

  /** Append the window message for one committed compaction.
   * @returns whether a window was opened. */
  announce(session, compactionId) {
    if (!this.active({ session })) return false;
    const summary = findSummary(session, compactionId);
    if (!summary) return false;
    const { header } = this.windows.prepare(session, this.getConfig().handoffMaxChars, summary);
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: header }], source: SOURCE }), { surfaceOp: 'append' });
    return true;
  }

  /** Serialize each session's notes, capturing the committed window before IO queues.
   * Other sessions and native rotation never wait for a slow note write. */
  writeHandoff(session) {
    const windowId = this.states.get(session).windows.at(-1).window_id;
    const previous = this.sessionHandoffWrites.get(session) ?? Promise.resolve();
    const pending = previous
      .then(async () => { if (await recordHandoff(this.states, session, undefined, windowId)) await this.flush(session); })
      .catch(error => this.ctx.logger?.warn?.('context-management: handoff note was not written', error));
    this.sessionHandoffWrites.set(session, pending);
    // An aggregate completion receipt, not a dependency between session queues.
    this.handoffWrites = Promise.all([this.handoffWrites, pending]).then(() => {});
  }

  finishPending(session, seq, reason, visible = true) {
    endRequest(this.states, session, seq, reason, visible);
  }
}

/** The `compaction/summary` of one compaction; it sits a few events before its end. */
function findSummary(session, compactionId) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event.type === 'compaction/summary' && event.data.compactionId === compactionId) return event;
    if (event.type === 'compaction/start' && event.data.compactionId === compactionId) return null;
  }
  return null;
}

/** Clears a pending new_context request and, when `visible`, tells the model why
 * the requested window did not arrive. */
export function endRequest(states, session, seq, reason, visible = true) {
  states.finishRequest(session, seq);
  if (visible) session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: reason }],
    source: SOURCE,
  }), { surfaceOp: 'append' });
}
