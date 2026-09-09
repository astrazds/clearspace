const DATABASE_NAME = 'clearspace-rules';
const DATABASE_VERSION = 1;

/** @typedef {import('./source-validation.js').CompiledRules} CompiledRules */
/** @typedef {import('./source-validation.js').SourceId} SourceId */
/** @typedef {import('./source-validation.js').SourceMetadata} SourceMetadata */
/** @typedef {'snapshots' | 'compiled' | 'metadata'} StoreName */
/** @typedef {{ sourceId: SourceId, text: string }} SnapshotRecord */
/** @typedef {{ sourceId: SourceId, data: CompiledRules }} CompiledRecord */
/** @typedef {SnapshotRecord | CompiledRecord | SourceMetadata} DatabaseRecord */

/**
 * @param {IDBFactory} [indexedDBImpl]
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase(indexedDBImpl = indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const store of ['snapshots', 'compiled', 'metadata']) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: 'sourceId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open rule database'));
  });
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<void>}
 */
function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
  });
}

/**
 * @overload
 * @param {'metadata'} storeName
 * @param {SourceId} sourceId
 * @returns {Promise<SourceMetadata | undefined>}
 */
/**
 * @overload
 * @param {'compiled'} storeName
 * @param {SourceId} sourceId
 * @returns {Promise<CompiledRecord | undefined>}
 */
/**
 * @overload
 * @param {'snapshots'} storeName
 * @param {SourceId} sourceId
 * @returns {Promise<SnapshotRecord | undefined>}
 */
/**
 * @param {StoreName} storeName
 * @param {SourceId} sourceId
 * @returns {Promise<DatabaseRecord | undefined>}
 */
export async function getRecord(storeName, sourceId) {
  const database = await openDatabase();
  try {
    return await requestResult(database.transaction(storeName).objectStore(storeName).get(sourceId));
  } finally {
    database.close();
  }
}

/**
 * @overload
 * @param {'metadata'} storeName
 * @returns {Promise<SourceMetadata[]>}
 */
/**
 * @overload
 * @param {'compiled'} storeName
 * @returns {Promise<CompiledRecord[]>}
 */
/**
 * @overload
 * @param {'snapshots'} storeName
 * @returns {Promise<SnapshotRecord[]>}
 */
/**
 * @param {StoreName} storeName
 * @returns {Promise<DatabaseRecord[]>}
 */
export async function getAllRecords(storeName) {
  const database = await openDatabase();
  try {
    return await requestResult(database.transaction(storeName).objectStore(storeName).getAll());
  } finally {
    database.close();
  }
}

/**
 * @param {SourceId} sourceId
 * @param {string} text
 * @param {CompiledRules} compiled
 * @param {SourceMetadata} metadata
 * @returns {Promise<void>}
 */
export async function replaceSourceAtomically(sourceId, text, compiled, metadata) {
  const database = await openDatabase();
  const transaction = database.transaction(['snapshots', 'compiled', 'metadata'], 'readwrite');
  transaction.objectStore('snapshots').put({ sourceId, text });
  transaction.objectStore('compiled').put({ sourceId, data: compiled });
  transaction.objectStore('metadata').put(metadata);
  try {
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

/**
 * @param {SourceMetadata} metadata
 * @returns {Promise<void>}
 */
export async function putMetadata(metadata) {
  const database = await openDatabase();
  const transaction = database.transaction('metadata', 'readwrite');
  transaction.objectStore('metadata').put(metadata);
  try {
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}
