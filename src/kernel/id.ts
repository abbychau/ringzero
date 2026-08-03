/** Tiny unique id generator (no deps). */
export function newId(prefix = 'msg'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
