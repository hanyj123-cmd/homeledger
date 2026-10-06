// 브라우저 안의 로컬 저장소 (IndexedDB). 화면은 항상 여기서 읽어서 즉시 뜹니다.
import { KEYS } from './config.js';

const DB_NAME = 'homeledger';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      Object.keys(KEYS).forEach((s) => {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEYS[s] });
      });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export async function getAll(store) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function getMeta(key) {
  const db = await openDB();
  return reqP(db.transaction('meta', 'readonly').objectStore('meta').get(key));
}

export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  return txDone(tx);
}

export async function getOutbox() {
  const all = await getAll('outbox');
  return all.sort((a, b) => a.seq - b.seq);
}

export async function deleteOutbox(seq) {
  const db = await openDB();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').delete(seq);
  return txDone(tx);
}

// 여러 저장소 + 전송 대기열을 한 번에(전부 성공하거나 전부 취소) 기록합니다.
export async function commit(puts, outboxOps) {
  const db = await openDB();
  const stores = Object.keys(puts || {});
  stores.push('outbox');
  const tx = db.transaction(stores, 'readwrite');
  Object.keys(puts || {}).forEach((s) => {
    const os = tx.objectStore(s);
    puts[s].forEach((row) => os.put(row));
  });
  (outboxOps || []).forEach((op) => tx.objectStore('outbox').add(Object.assign({}, op, { created: Date.now() })));
  return txDone(tx);
}

// 시트에서 받아온 행으로 로컬을 갱신합니다. protect 에 든 키(전송 대기 중인 행)는 건드리지 않습니다.
export async function mergeRemote(store, rows, protect) {
  const db = await openDB();
  const keyPath = KEYS[store];
  const existingKeys = await reqP(db.transaction(store, 'readonly').objectStore(store).getAllKeys());
  const remoteKeys = new Set(rows.map((r) => String(r[keyPath])));
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  existingKeys.forEach((k) => {
    if (!remoteKeys.has(String(k)) && !protect.has(String(k))) os.delete(k);
  });
  rows.forEach((r) => {
    if (!protect.has(String(r[keyPath]))) os.put(r);
  });
  return txDone(tx);
}

export async function clearStore(store) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return txDone(tx);
}
