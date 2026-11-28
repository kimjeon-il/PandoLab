import test from 'node:test';
import assert from 'node:assert/strict';
import {createObjectSearchIndex, searchObjectSearchIndex} from '../../../src/document/object-search-model.js';
import {createObjectSearchRuntime} from '../../../src/document/object-search-runtime.js';

const RPC = 'pandolab-worker-rpc';

class SearchWorkerMock {
  onmessage = null;
  onerror = null;
  index = null;
  terminated = false;

  postMessage(message) {
    if (message.type !== 'request') return;
    queueMicrotask(() => {
      let result;
      let error = null;
      try {
        if (message.operation === 'object-search.index') {
          const built = createObjectSearchIndex(message.payload.catalog);
          this.index = {key:message.payload.key, terms:built.terms};
          result = {key:message.payload.key, order:built.order};
        } else if (message.operation === 'object-search.query') {
          if (!this.index || this.index.key !== message.payload.key) throw new Error('Stale index');
          result = {key:message.payload.key,
            indices:searchObjectSearchIndex(this.index, message.payload.query)};
        } else if (message.operation === 'object-search.clear') {
          this.index = null;
          result = null;
        } else throw new Error('Unknown operation');
      } catch (cause) {
        error = {category:'OPERATION', code:'TEST-WORKER', message:cause.message};
      }
      this.onmessage?.({data:{
        rpc:RPC, protocolVersion:1, type:'result', requestId:message.requestId,
        operation:message.operation, projectRevision:message.projectRevision,
        ok:!error, result, error, timing:{durationMs:0},
      }});
    });
  }

  terminate() {this.terminated = true;}
}

const catalog = {
  keys:['objects:2','objects:1','labels:3'],
  ids:['2','1','3'],
  names:['부산','서울','세종'],
  typeLabels:['객체','객체','도시'],
  searchTexts:['항구','수도','행정수도'],
};

test('object search index sorts once and returns compact matching positions', () => {
  const index = createObjectSearchIndex(catalog);
  assert.deepEqual([...index.order], [0, 1, 2]);
  assert.deepEqual([...searchObjectSearchIndex(index, '수도')], [1, 2]);
  assert.deepEqual([...searchObjectSearchIndex(index, '항구')], [0]);
  assert.deepEqual([...searchObjectSearchIndex(index, '')], []);
});

test('object search runtime reuses its revision index and invalidates it explicitly', async () => {
  let created = 0;
  let worker;
  const runtime = createObjectSearchRuntime({createWorker:() => {
    created++;
    worker = new SearchWorkerMock();
    return worker;
  }});
  const smallCatalog = {
    keys:['objects:2','objects:1'],
    ids:['2','1'],
    names:['부산','서울'],
    typeLabels:['객체','객체'],
    searchTexts:['항구','수도'],
  };

  const order = await runtime.prepare({key:'project-a:1', catalog:smallCatalog});
  assert.deepEqual([...order], [0, 1]);
  assert.equal(await runtime.prepare({key:'project-a:1', catalog:smallCatalog}), order);
  assert.deepEqual([...await runtime.search({key:'project-a:1', query:'수도'})], [1]);
  assert.equal(created, 1);

  await runtime.invalidate();
  await runtime.prepare({key:'project-a:2', catalog:smallCatalog});
  assert.equal(created, 1);
  assert.deepEqual([...await runtime.search({key:'project-a:2', query:'항구'})], [0]);
  runtime.dispose();
  assert.equal(worker.terminated, true);
});
