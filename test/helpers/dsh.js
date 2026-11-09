import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let dshRoot = process.env.DSH_PACKAGE_DIR;
if (!dshRoot) {
  try { dshRoot = dirname(require.resolve('@deepseek-ai/dsh/package.json')); }
  catch { throw new Error('Install the DSH dev dependency, or set DSH_PACKAGE_DIR to the installed @deepseek-ai/dsh package directory.'); }
}
const fromDsh = createRequire(join(dshRoot, 'package.json'));
export { dshRoot };
export async function dsh(name) { return import(pathToFileURL(fromDsh.resolve('@deepseek-ai/' + name)).href); }
export const { Context } = await dsh('cordis');
export const { Session, SessionStore } = await dsh('dsh-session');
export const { TokenMeter } = await dsh('dsh-token-meter');
export const { BasicCompactionEngine } = await dsh('dsh-compaction-basic');
export const { SettingsProvider } = await dsh('dsh-settings');
export const { SystemPrompt } = await dsh('dsh-system-prompt');
export const llm = await dsh('dsh-llm');

/** BasicCompactionEngine with a fixture summarizer: `summarize()` is DSH's
 * documented customization hook, the rest of the engine runs unchanged. */
export class FixtureCompactionEngine extends BasicCompactionEngine {
  summarizer = null;
  onSummarize = null;
  summarize(input, agent, signal) {
    this.onSummarize?.();
    return this.summarizer(input, agent, signal);
  }
}

export function user(session, text) {
  return session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' });
}
export const { SessionProjectionRegistry } = await dsh('dsh-session-projection');
export const { ToolRuntime } = await dsh('dsh-tools');
export const { NativeToolExecutor } = await dsh('dsh-tool-executor-native');
export const { CommandRuntime } = await dsh('dsh-commands');

/**
 * Mount the real JSONL backend. DSH <= 0.2.0 exports the backend class;
 * 0.2.1+ exports only a plugin that provides the `sessionPersistence` service.
 */
export async function jsonlStorage(ctx, config) {
  const storageModule = await dsh('dsh-session-persistence-jsonl');
  const JsonlSessionPersistence = storageModule.JsonlSessionPersistence ?? storageModule.default;
  if (typeof JsonlSessionPersistence === 'function') return new JsonlSessionPersistence(ctx, config);
  const { packChunks, ...pluginConfig } = config;
  await ctx.plugin(storageModule, pluginConfig).await();
  return ctx.get('sessionPersistence');
}

import { installSettings } from './native-settings-fixture.mjs';

export async function fixture(options = {}) {
  const ctx = new Context();
  ctx.provide('llm', {
    resolveModelInfo: async () => ({ context: { contextWindow: options.capacity ?? 20_000 } }),
    imageRequestPricing: () => undefined,
  });
  new SessionProjectionRegistry(ctx);
  new SessionStore(ctx);
  new TokenMeter(ctx);
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx);
  // DSH 0.2.1+ moved execution out of the registry: mount the native executor.
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  new CommandRuntime(ctx);
  const attach = await installSettings(ctx, dsh);
  // A test durability listener records the exact immutable snapshot crossing the
  // real SessionStore flush seam. A separate JSONL test exercises disk restore.
  const persisted = new Map();
  const root = options.diskRoot ?? mkdtempSync(join(tmpdir(), 'dsh-context-fixture-'));
  // Notes live under the Harness home; keep every fixture inside its temporary root.
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const storage = await jsonlStorage(ctx, { root, compression: 'none', packChunks: true });
  ctx.on('session/flush', session => { persisted.set(session.id, structuredClone(session.snapshotEvents())); });
  const handles = new Map();
  const handleApi = typeof storage.open === 'function';
  // DSH's own engine, untouched; only its LLM summarizer is a fixture, so tests
  // never call a paid model. `native.summarizer` swaps that fixture per test.
  const native = options.noHostCompaction ? null : new FixtureCompactionEngine(ctx, { auto: options.auto ?? true, retainTokens: 800, headroomTokens: 1024 });
  let legacyCalls = 0;
  if (native) native.summarizer = async () => {
    const summary = [{ type: 'text', text: 'Fixture native summary.' }];
    return { summary, rawOutput: summary, provider: 'fixture', model: 'fixture' };
  };
  if (native) native.onSummarize = () => { legacyCalls++; };
  let plugin;
  // Tests exercise the full tool surface; the lazy gate has its own test.
  const config = { lazyTools: false, ...(options.config ?? {}) };
  const module = await import('../../lib/index.js');
  const fiber = ctx.plugin({ ...module.default, apply(child, cfg) { child.fiber.appliedConfig = cfg; plugin = module.apply(child, cfg); } }, config);
  await fiber.await();
  attach('context-management', fiber, config);
  if (!plugin) throw new Error('Plugin did not activate');
  async function agent(id = 'test-agent') {
    const session = ctx.sessions.prepare(id);
    if (handleApi) handles.set(id, await storage.create(session.header));
    ctx.effect(() => {
      const detach = ctx.sessions.enter(session);
      ctx.sessions.announce(session);
      return detach;
    });
    let busy = false;
    return { id, session, options: { provider: 'fixture', model: 'fixture' },
      runMaintenance(task) {
        if (busy) throw new Error('agent is busy');
        busy = true;
        return Promise.resolve().then(() => task(new AbortController().signal)).finally(() => { busy = false; });
      },
      setBusy(value) { busy = value; },
    };
  }
  async function execute(agent, name, args = {}) {
    const signal = new AbortController().signal;
    // DSH 0.2.2 executes a batch and admits conditional tools per step.
    const toolSet = await ctx.tools.resolve({ agent, signal });
    const batch = await ctx.tools.execute({ agent, signal, toolSet,
      calls: [{ id: 'test-call', name, arguments: JSON.stringify(args) }] });
    const result = batch.results[0]?.result;
    if (!result) throw new Error(`tool ${name} produced no result`);
    return result;
  }
  let closed = false;
  return { ctx, native, plugin, fiber, agent, execute, persisted, storage, root,
    notesRoot: () => join(root, 'context-management', 'notes'),
    get legacyCalls() { return legacyCalls; },
    dispose: async () => {
      if (closed) return;
      closed = true;
      if (handleApi) {
        await storage.flush();
        for (const handle of handles.values()) await handle.close();
      }
      await ctx.fiber.dispose();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      if (!options.diskRoot) rmSync(root, { recursive: true, force: true });
    },
  };
}
