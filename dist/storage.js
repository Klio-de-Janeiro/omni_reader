let database;
/** Open the device-local file store. */
async function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('omni-reader', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}
/** Complete a transaction before reporting a durable result. */
async function transact(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const req = action(tx.objectStore('files'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
  });
}
export const listFiles = () => transact('readonly', store => store.getAll());
export const removeFile = id => transact('readwrite', store => store.delete(id));
/** Bound persistent copies to 20 files and 256 MiB per browser. */
export async function saveFile(record) {
  const files = await listFiles();
  const other = files.filter(file => file.id !== record.id);
  if (other.length >= 20 || other.reduce((sum, file) => sum + file.size, 0) + record.size > 256 * 1024 * 1024) throw new Error('Лимит сохранения: 20 файлов или 256 МиБ. Удалите ненужную копию из списка.');
  await transact('readwrite', store => store.put(record));
}
