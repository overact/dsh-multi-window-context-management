/** Bounded discovery and exact reads over the calling session's immutable log. */
import { jsonToolOutput } from './output.js';

export const historySearchToolDefinition = {
  name: 'history_search',
  description: 'Search session history; scope=windows lists windows.',
  output: jsonToolOutput('object'),
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['messages', 'windows'], description: 'Default messages.' },
      query: { type: 'string', minLength: 1, maxLength: 256 },
      window_id: { type: 'string' },
      role: { type: 'string', enum: ['user', 'assistant', 'tool', 'system', 'developer'] },
      tool_namespace: { type: 'string' },
      tool_name: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
      recent_first: { type: 'boolean', description: 'Newest first (default).' },
      cursor: { type: 'integer', minimum: 0 },
      max_chars_per_item: { type: 'integer', minimum: 0, maximum: 1000, description: 'Default 400.' },
      case_sensitive: { type: 'boolean', description: 'Default true.' },
    },
    additionalProperties: false,
  },
};

export const historyReadToolDefinition = {
  name: 'history_read',
  description: 'Read a history item by ID, including summary/goal/todo records.',
  output: jsonToolOutput('object'),
  parameters: {
    type: 'object',
    properties: {
      item_id: { type: 'string' },
      window_id: { type: 'string' },
      offset_chars: { type: 'integer', minimum: 0 },
      limit_chars: { type: 'integer', minimum: 1, maximum: 20000, description: 'Default 8000.' },
      format: { type: 'string', enum: ['text', 'json'], description: 'text (default) or json.' },
    },
    required: ['item_id'],
    additionalProperties: false,
  },
};

export const historyToolDefinitions = [historySearchToolDefinition, historyReadToolDefinition];

export function createHistoryHandlers(source) {
  const store = (args, exec) => {
    const current = typeof source === 'function' ? source(exec) : source;
    // ToolRuntime may pass undeclared arguments; they never select a session.
    if (args.agent_name !== undefined) throw new Error('History is private to the current session; agent_name is unsupported.');
    exec?.signal?.throwIfAborted();
    return current;
  };
  return {
    history_search: async (args = {}, exec) => {
      if (args.scope === 'windows') {
        if (['query', 'window_id', 'role', 'tool_namespace', 'tool_name', 'max_chars_per_item', 'case_sensitive'].some(key => args[key] !== undefined)) {
          throw new Error('Window directory accepts only cursor, limit and recent_first.');
        }
        return store(args, exec).listWindows(args);
      }
      if (args.scope !== undefined && args.scope !== 'messages') throw new Error('Unknown history scope.');
      return args.query === undefined ? store(args, exec).listItems(args) : store(args, exec).searchContents(args);
    },
    history_read: async (args = {}, exec) => store(args, exec).readItem(args)
      ?? { error: `History item not found in the current session: ${args.item_id}` },
  };
}
