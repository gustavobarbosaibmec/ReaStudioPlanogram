// Armazenamento local chave-valor em IndexedDB (fotos não cabem no localStorage).
// Sem IndexedDB (modo privado restrito), cai para memória: o app funciona na sessão.

const DB_NAME = 'planograma';
const STORE = 'kv';
const memory = new Map();
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export async function get(key, fallback = null) {
  if (!(await open())) return memory.has(key) ? memory.get(key) : fallback;
  const value = await run('readonly', (s) => s.get(key));
  return value === undefined ? fallback : value;
}

export async function set(key, value) {
  if (!(await open())) {
    memory.set(key, value);
    return;
  }
  await run('readwrite', (s) => s.put(value, key));
}
