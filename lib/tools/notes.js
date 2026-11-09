/** Session-private notes: one bounded read interface and one durable write interface. */
import { requireSession } from '../session-state.js';
import { boundedInt, page } from '../text.js';
import { jsonToolOutput } from './output.js';

const tool = (name, description, properties, required) => ({
  name, description, output: jsonToolOutput('object'),
  parameters: { type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false },
});

export const notes_read = tool('notes_read',
  'Read session notes: path reads a file, query searches lines, neither lists files.', {
    path: { type: 'string' },
    query: { type: 'string', minLength: 1, maxLength: 256, description: 'Literal, case-sensitive (max 256).' },
    prefix: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 64, description: 'List 20, search 5 (max 64/10).' },
    start_line: { type: 'integer', description: '1-based; negative from end.' },
    stop_line: { type: 'integer', description: 'Inclusive; negative from end.' },
    offset_chars: { type: 'integer', minimum: 0 },
    limit_chars: { type: 'integer', minimum: 1, maximum: 20000, description: 'Default 8000.' },
  });

export const notes_write = tool('notes_write',
  'Write a session-private note; replace overwrites, append adds.', {
    path: { type: 'string' },
    text: { type: 'string' },
    mode: { type: 'string', enum: ['replace', 'append'], description: 'replace or append.' },
  }, ['path', 'text', 'mode']);

export const NOTES_TOOLS = { notes_read, notes_write };

export function readNotes(store, args = {}) {
  if (args.agent_name !== undefined) throw new Error('Notes are private to the current session; agent_name is unsupported.');
  if (args.path !== undefined) {
    if (args.query !== undefined || args.prefix !== undefined || args.limit !== undefined) {
      throw new Error('Read by path cannot be combined with query, prefix or limit.');
    }
    const result = store.readFile('self', args.path, args.start_line, args.stop_line);
    return { ...result, ...page(result.content, boundedInt(args.offset_chars, 0, Number.MAX_SAFE_INTEGER), boundedInt(args.limit_chars, 8000, 20000, 1)) };
  }
  if (['start_line', 'stop_line', 'offset_chars', 'limit_chars'].some(key => args[key] !== undefined)) {
    throw new Error('Line ranges and character paging require a path.');
  }
  if (args.query !== undefined) {
    if (typeof args.query !== 'string' || !args.query.length || args.query.length > 256) throw new Error('Search query must contain 1–256 characters.');
    return { matches: store.searchContents('self', args.query, args.prefix, 5, boundedInt(args.limit, 5, 10, 1), true)
      .map(file => ({ ...file, matches: file.matches.map(match => ({ ...match,
        line: match.line.slice(0, 400), truncated: match.line.length > 400 })) })) };
  }
  return { files: store.listFilesByPrefix('self', args.prefix ?? '', boundedInt(args.limit, 20, 64, 1)) };
}

export function createNotesHandlers(states, flush, checkEnabled) {
  return {
    notes_read: async (args = {}, exec) => {
      checkEnabled();
      exec.signal?.throwIfAborted();
      return readNotes(states.get(requireSession(exec)).notes, args);
    },
    notes_write: async (args = {}, exec) => {
      checkEnabled();
      exec.signal?.throwIfAborted();
      const session = requireSession(exec);
      if (args.agent_name !== undefined) throw new Error('Notes are private to the current session; agent_name is unsupported.');
      if (args.mode !== 'replace' && args.mode !== 'append') throw new Error('notes_write requires mode: replace or append.');
      const result = await states.writeNote(session, args.path, args.text, args.mode === 'replace' ? 'write' : 'append', exec.signal);
      await flush(session);
      return result;
    },
  };
}
