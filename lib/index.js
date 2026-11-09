import z from '@deepseek-ai/schemastery';
import { SessionStateStore, requireSession } from './session-state.js';
import { NoteRepository } from './note-repository.js';
import { HistoryStore } from './history-store.js';
import { toolsEnabled } from './window-policy.js';
import { WindowController, endRequest } from './window-controller.js';
import { createNewContextHandler, newContextToolDefinition } from './tools/new-context.js';
import { NOTES_TOOLS, createNotesHandlers } from './tools/notes.js';
import { historyToolDefinitions, createHistoryHandlers } from './tools/history.js';
import { HANDOFF_NOTE, HANDOFF_LOG } from './handoff-note.js';
import { resolveLocale, translator, description } from './locale.js';

export const name = 'context-management';
export const inject = ['tools', 'sessions', 'commands', 'systemPrompt', 'settings'];
/** Slash commands that toggle the plugin; preflight checks nobody else owns them. */
export const COMMAND_NAMES = ['ctx'];
const PlainConfig = z.object({
  enabled: z.boolean().default(true).description(description('config.enabled')),
  overrideCompaction: z.boolean().default(true).description(description('config.overrideCompaction')),
  injectTools: z.boolean().default(true).description(description('config.injectTools')),
  lazyTools: z.boolean().default(true).description(description('config.lazyTools')),
  defaultStrategy: z.union(['window', 'native']).default('window').description(description('config.defaultStrategy')),
  modelPolicies: z.array(z.object({ provider: z.string().required(), model: z.string().required(), strategy: z.union(['window', 'native']).required() })).default([]).description(description('config.modelPolicies')),
  handoffMaxChars: z.number().min(4000).max(32000).default(6000).description(description('config.handoffMaxChars')),
});

export const Config = z.object(Object.fromEntries(Object.entries(PlainConfig.dict).map(([key, schema]) => [key, schema.volatile()])));

/** Cordis lifecycle owns all registrations and restores the original hooks on unload. */
export function apply(ctx, config = {}) {
  const readConfig = () => PlainConfig(Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value?.get === 'function' ? value.get() : value])));
  let current = readConfig();
  let locale = resolveLocale(ctx);
  let t = translator(locale);
  const states = new SessionStateStore(new NoteRepository());
  // Read by other plugins (dsh-autocompact): pending rotations and the strategy config.
  const contextWindows = { states, getConfig: () => current };
  ctx.provide('contextWindows', contextWindows);
  const flush = async session => {
    if (!await ctx.sessions.flush(session)) throw new Error('Durable context notes require a DSH session persistence backend.');
  };
  const windows = new WindowController(ctx, states, () => current, flush, () => locale);
  let unregisterTools = [];
  let registered = false;
  let disposed = false;
  const checkEnabled = () => {
    if (disposed || !toolsEnabled(current)) throw new Error('Context management tools are disabled.');
  };
  const history = createHistoryHandlers(exec => {
    checkEnabled();
    return new HistoryStore(requireSession(exec), states);
  });
  const newContext = createNewContextHandler(states, flush, checkEnabled);
  const notes = createNotesHandlers(states, flush, checkEnabled);

  function syncTools() {
    const enabled = toolsEnabled(current) && !disposed;
    if (registered === enabled) return;
    for (const dispose of unregisterTools.splice(0)) dispose();
    registered = false;
    if (!enabled) return;
    // notes/history are only useful once a window has rotated; hiding them until
    // then keeps their schemas out of every pre-rotation request.
    const rotated = ({ agent }) => {
      try { return states.get(agent.session).windows.length > 1; } catch { return false; }
    };
    const gate = current.lazyTools ? { when: rotated } : undefined;
    const tools = [
      { definition: { ...newContextToolDefinition, execute: (args, exec) => {
        checkEnabled();
        requireSession(exec);
        if (!windows.compactionFor(exec.agent)) throw new Error('This agent preset has no compaction engine. new_context is unavailable; notes and history remain usable.');
        if (!windows.active(exec.agent)) throw new Error('This model uses native compaction. new_context is unavailable; notes and history remain usable.');
        return newContext(args, exec);
      } } },
      ...Object.values(NOTES_TOOLS).map(tool => ({ definition: { ...tool, execute: notes[tool.name] }, gate })),
      ...historyToolDefinitions.map(tool => ({ definition: { ...tool, execute: history[tool.name] }, gate })),
    ];
    try {
      for (const { definition, gate: when } of tools) unregisterTools.push(ctx.tools.register(definition, when));
      registered = true;
    } catch (error) {
      for (const dispose of unregisterTools.splice(0)) dispose();
      throw error;
    }
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    windows.close();
    syncTools();
  };
  ctx.effect(() => dispose, 'context-management tools');
  ctx.on('settings/document-updated', ns => {
      if (ns === 'locale') {
        locale = resolveLocale(ctx);
        t = translator(locale);
        registerCommands();
        return;
      }
      if (ns !== name) return;
      const hadTools = toolsEnabled(current);
      current = readConfig();
      if (hadTools && !toolsEnabled(current)) {
        for (const session of ctx.sessions.list()) {
          const state = states.states.get(session);
          if (state?.pending) endRequest(states, session, state.pending.seq, 'Context management was disabled; the requested context window will not be created.');
        }
      }
      syncTools();
  });
  syncTools();
  // Live commits only: seed (replayed) events never publish on session/event.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/end') windows.compactionEnded(session, event);
  });
  // A requested window rotates at the next step boundary, once every sibling
  // tool result has reached the log.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (toolsEnabled(current) && states.get(agent.session).pending) await windows.rotatePending(agent, signal);
    return next();
  });
  ctx.systemPrompt.section({
    name: 'tool:context-management', order: 2450,
    text: () => toolsEnabled(current)
      ? t('prompt.section', { note: HANDOFF_NOTE, log: HANDOFF_LOG })
      : '',
  });
  let toggleTail = Promise.resolve();
  const toggle = () => {
    const task = toggleTail.then(async () => {
      const next = !readConfig().enabled;
      await ctx.settings.update(name, { enabled: next });
      return { kind: 'success', text: t(next ? 'ctx.enabled' : 'ctx.disabled') };
    });
    toggleTail = task.catch(() => {});
    return task;
  };
  let commandDisposers = [];
  const registerCommands = () => {
    for (const dispose of commandDisposers.splice(0)) dispose();
    for (const command of COMMAND_NAMES) commandDisposers.push(ctx.commands.register({ name: command, description: t('command.ctx'), handler: toggle }));
  };
  registerCommands();
  return { states, contextWindows, windows, get enabled() { return current.enabled; }, get handoffWrites() { return windows.handoffWrites; }, dispose };
}

export default { name, inject, Config, apply };
