/**
 * Model registry.
 *
 * Models define the primary structural metaphor of a unifile document —
 * how sections are arranged in coordinate space or time. They are
 * orthogonal to DSLs, which define how individual section *content* is
 * parsed and rendered.
 *
 * The active model for a document is declared in its front matter:
 *
 *   ---
 *   model: timeline
 *   model2: graph
 *   ---
 *
 * Built-in models
 * ───────────────
 *   flow     — vertically scrolling document (default; current behaviour)
 *   grid     — spreadsheet-style cell grid
 *   spatial  — x/y (or x/y/z) coordinate space
 *   timeline — track-based time layout
 *   graph    — entity-relationship graph
 *
 * Additional model plugins can be installed at runtime in future; for now
 * only the five built-ins are supported.
 *
 * @typedef {{
 *   id:          string,
 *   name:        string,
 *   abbr:        string,
 *   description: string,
 * }} ModelDef
 */

/** @type {Map<string, ModelDef>} */
const _registry = new Map();

/**
 * Register a model definition.
 * @param {ModelDef} model
 */
export function registerModel(model) {
  _registry.set(model.id, model);
}

/**
 * Get a model by ID.  Falls back to 'flow' if the id is unknown.
 * @param {string|null|undefined} id
 * @returns {ModelDef}
 */
export function getModel(id) {
  return _registry.get(id) ?? _registry.get('flow');
}

/**
 * List all registered models in registration order.
 * @returns {ModelDef[]}
 */
export function listModels() {
  return [..._registry.values()];
}

// ---------------------------------------------------------------------------
// Built-in model definitions — registered at module load time
// ---------------------------------------------------------------------------

[
  {
    id: 'flow',
    name: 'Flow',
    abbr: 'Fl',
    description: 'Vertically scrolling document — sections stack top to bottom',
  },
  {
    id: 'grid',
    name: 'Grid',
    abbr: 'Gr',
    description: 'Spreadsheet-style cell grid — sections occupy named cells',
  },
  {
    id: 'spatial',
    name: 'Spatial',
    abbr: 'Sp',
    description: 'X/Y (or X/Y/Z) coordinate space — sections placed at positions',
  },
  {
    id: 'timeline',
    name: 'Timeline',
    abbr: 'Tl',
    description: 'Track-based time layout — sections live in lanes at timestamps',
  },
  {
    id: 'graph',
    name: 'Graph',
    abbr: 'Gp',
    description: 'Entity-relationship graph — sections are nodes and edges',
  },
].forEach(registerModel);
