// Tiny event bus shared by every module.
const handlers = new Map();
export const bus = {
  on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => bus.off(evt, fn); },
  off(evt, fn) { handlers.get(evt)?.delete(fn); },
  emit(evt, payload = {}) { const hs = handlers.get(evt); if (!hs) return; for (const fn of [...hs]) { try { fn(payload); } catch (e) { console.error(`bus handler for ${evt} failed`, e); } } },
  clear() { handlers.clear(); },
};
