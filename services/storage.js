// Reality Engine · services/storage — namespaced local persistence.
// All engine + mode state lives under the "re." localStorage prefix so it can be
// listed and cleared as a unit from Settings. Values are JSON round-tripped.

const PREFIX = "re.";

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private mode / full */ }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  },
  keys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
      }
    } catch { /* ignore */ }
    return out;
  },
  clearAll() {
    for (const k of this.keys()) this.remove(k);
  },
  // Scoped view for a mode: storage.scope("pendulum").get("L")
  scope(ns) {
    return {
      get: (key, fallback) => storage.get(`${ns}.${key}`, fallback),
      set: (key, value) => storage.set(`${ns}.${key}`, value),
      remove: (key) => storage.remove(`${ns}.${key}`),
    };
  },
};

export default storage;
