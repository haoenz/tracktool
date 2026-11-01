import { printDocument, type PrintDocument } from "../shared/print.js";

export interface StoredPrint {
  id: string;
  archive: string;
  updatedAt: number;
  document: PrintDocument;
}
const NAME = "tracktool-print";
const STORE = "drafts";
const LIMIT = 10;
let database: Promise<IDBDatabase> | undefined;

// getRandomValues also works on LAN HTTP pages, where randomUUID is missing.
function draftId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function open() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("archive", "archive", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

export async function listPrints(): Promise<StoredPrint[]> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  const done = committed(tx);
  const store = tx.objectStore(STORE);
  const request = store.getAll();
  let rows: StoredPrint[] = [];
  request.onsuccess = () => {
    rows = (request.result as StoredPrint[]).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    // Also repair excess rows left behind by older browser sessions.
    for (const old of rows.slice(LIMIT)) store.delete(old.id);
  };
  await done;
  return rows.slice(0, LIMIT);
}

export async function savePrint(
  document: PrintDocument,
  id?: string,
): Promise<string> {
  id ??= draftId();
  const db = await open();
  const record: StoredPrint = {
    id,
    archive: document.archive,
    updatedAt: Date.now(),
    document: printDocument(document, document.archive, document.tracks),
  };
  // Commit the write and eviction atomically; request success alone does not
  // mean that IndexedDB has committed (quota errors can still abort it).
  const tx = db.transaction(STORE, "readwrite");
  const done = committed(tx);
  const store = tx.objectStore(STORE);
  store.put(record);
  const rows = store.getAll();
  rows.onsuccess = () => {
    const sorted = (rows.result as StoredPrint[]).sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || (a.id === id ? -1 : b.id === id ? 1 : 0),
    );
    for (const old of sorted.slice(LIMIT)) store.delete(old.id);
  };
  await done;
  return id;
}

export async function deletePrint(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  const done = committed(tx);
  tx.objectStore(STORE).delete(id);
  await done;
}

function committed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("草稿保存失败"));
    tx.onerror = () => reject(tx.error ?? new Error("草稿保存失败"));
  });
}
