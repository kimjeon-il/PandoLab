export function createBrowserProjectStorage({
  productMode = 'viewer',
  indexedDB,
  databaseName,
  storeName,
  viewKey,
  databaseVersion = 2,
}) {
  if (productMode!=='viewer')throw new TypeError('Project storage requires viewer product mode.');
  let databasePromise = null;
  const documentKey = id => {
    if (typeof id!=='string'||!id.trim())throw new TypeError('Workspace documentId is required.');
    return `${viewKey}:${id}`;
  };

  function openDatabase() {
    if (!indexedDB) return Promise.reject(new Error('IndexedDB를 지원하지 않는 브라우저입니다.'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 열기 실패'));
      request.onblocked = () => reject(new Error('다른 창에서 자동저장 DB를 사용 중입니다.'));
    }).catch (error => { databasePromise = null; throw error; });
    return databasePromise;
  }

  async function readRecord(key, errorMessage) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onerror = () => reject(transaction.error || new Error(errorMessage));
    });
  }

  async function writeRecord(key, value, errorMessage) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error(errorMessage));
      transaction.onabort = () => reject(transaction.error || new Error(`${errorMessage} 취소`));
    });
  }

  return Object.freeze({
    readCamera: async projectId => readRecord(`${documentKey(projectId)}:camera`, '지도 위치 읽기 실패'),
    writeCamera: (projectId, camera) => writeRecord(`${documentKey(projectId)}:camera`, camera, '지도 위치 저장 실패'),
    readView: async documentId => {
      const record = await readRecord(documentKey(documentId), '보기 위치 읽기 실패');
      // A damaged or stale key must not install another project's viewing state.
      return record && typeof record === 'object' && record.documentId === documentId ? record : null;
    },
    writeView: view => writeRecord(documentKey(view?.documentId), view, '보기 위치 저장 실패'),
  });
}

/** Current Viewer view records and validated globe-camera restoration. */
export function createViewerViewStorage({storage, projectId, dataRevision, now = () => new Date().toISOString()}) {
  const documentId = `map-project:${projectId}:${dataRevision}`;
  function writeView(viewingPresentation, camera) {
    const record = {documentId, viewingPresentation, savedAt:now()};
    return Promise.all([storage.writeView(record), ...(camera?.projection?[storage.writeCamera(projectId, camera)]:[])]);
  }
  async function readCamera() {
    const camera = await storage.readCamera(projectId);
    if (camera?.projection!=='globe'||!Array.isArray(camera.center)||camera.center.length!==2||
      !camera.center.every(Number.isFinite)||!Number.isFinite(camera.zoom))return null;
    return {globeRotation:[-camera.center[0], -Math.max(-90, Math.min(90, camera.center[1])), 0],
      zoom:camera.zoom, bearing:camera.bearing, pitch:camera.pitch, roll:camera.roll};
  }
  return Object.freeze({writeView, readCamera, readView:() => storage.readView(documentId)});
}
