const DATABASE_NAME = 'clearspace-rules';
const DATABASE_VERSION = 1;

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

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
  });
}

export async function getRecord(storeName, sourceId) {
  const database = await openDatabase();
  try {
    return await requestResult(database.transaction(storeName).objectStore(storeName).get(sourceId));
  } finally {
    database.close();
  }
}

export async function getAllRecords(storeName) {
  const database = await openDatabase();
  try {
    return await requestResult(database.transaction(storeName).objectStore(storeName).getAll());
  } finally {
    database.close();
  }
}

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
