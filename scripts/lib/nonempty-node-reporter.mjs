import {Readable} from 'node:stream';
import {spec} from 'node:test/reporters';

// Node's aggregate can count a successfully loaded file as a passed test
// even when its name filter selected no scenarios. Use child-file summaries.
export default async function* nonemptyNodeReporter(source) {
 let passed=0;
 async function* observe() {
  for await(const event of source){
   if(event.type==='test:summary'&&event.data.file)passed+=event.data.counts.passed;
   yield event;
  }
 }
 for await(const output of Readable.from(observe()).compose(spec))yield output;
 if(!passed){
  yield '\nNo actual Node/GIS scenarios passed (empty or entirely skipped scope).\n';
  process.exitCode=1;
 }
}
