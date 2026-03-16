/**
 * DSL Plugin Registry
 *
 * Each DSL plugin must implement:
 *
 *   id          {string}   – unique identifier, e.g. 'markdown'
 *   name        {string}   – display name, e.g. 'Markdown'
 *   extensions  {string[]} – file extensions, e.g. ['.md']
 *   editorMode  {string}   – CodeMirror/editor mode hint
 *
 *   render(content: string, el: HTMLElement): Promise<void>
 *     Render `content` into `el`. Should clear el first.
 *
 *   exporters   {Record<string, Exporter>}
 *     Exporter: { label, mime, ext, export(content): Promise<Blob|string> }
 *
 *   detect(content: string): boolean
 *     Return true if `content` looks like this DSL.
 */

const _registry = new Map();

/**
 * Register a DSL plugin.
 * @param {object} plugin
 */
export function registerDSL(plugin) {
  if (!plugin.id || !plugin.name || !plugin.render) {
    throw new Error(`DSL plugin missing required fields: ${JSON.stringify(plugin)}`);
  }
  if (!plugin.label || !plugin.version) {
    throw new Error(`DSL plugin "${plugin.id}" missing required label or version fields`);
  }
  _registry.set(plugin.id, plugin);
}

/**
 * Get a DSL plugin by id.
 * @param {string} id
 * @returns {object}
 */
export function getDSL(id) {
  const plugin = _registry.get(id);
  if (!plugin) throw new Error(`Unknown DSL: "${id}". Available: ${[..._registry.keys()].join(', ')}`);
  return plugin;
}

/**
 * List all registered DSLs.
 * @returns {object[]}
 */
export function listDSLs() {
  return [..._registry.values()];
}

/**
 * Auto-detect DSL from content (falls back to first registered).
 * @param {string} content
 * @returns {object}
 */
export function detectDSL(content) {
  for (const plugin of _registry.values()) {
    if (plugin.detect && plugin.detect(content)) return plugin;
  }
  return _registry.values().next().value;
}
