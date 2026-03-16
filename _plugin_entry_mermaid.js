
// Plugin entry for mermaid
import pluginObj from '../src/dsl/mermaid.js';

// Export a function that accepts a register callback.
// The outer build wraps this in an IIFE string.
export function __pluginMain(register) {
  register(pluginObj);
}
