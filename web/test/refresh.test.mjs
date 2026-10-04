import {test} from 'node:test';
import {strictEqual,deepStrictEqual,rejects,ok} from 'node:assert';
import {RefreshGate,refreshSections,section,getJson} from '../src/refresh.ts';
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

test('slow refresh survives repeated polls without overlap or invalidating its result',async()=>{
  const gate=new RefreshGate(),slow=deferred();let calls=0,result;
  const task=async()=>{calls++;result=await slow.promise;};
  const first=gate.run(task);await Promise.resolve();
  strictEqual(gate.run(task),first);strictEqual(gate.run(task),first);strictEqual(calls,1);
  slow.resolve('state loaded');await first;strictEqual(result,'state loaded');
  await gate.run(async()=>{calls++;});strictEqual(calls,2);
});
test('state and queue display immediately even if plans fail and another section is still waiting',async()=>{
  const slow=deferred(),shown=[];
  const job=refreshSections([
    section('State',async()=>({phase:'PREPARING'}),v=>shown.push(v.phase)),
    section('Queue',async()=>[1,2],v=>shown.push(v.length)),
    section('Plans',async()=>{throw Error('HTTP 500');},()=>{throw Error('failed section must not apply');}),
    section('Graph',()=>slow.promise,v=>shown.push(v))
  ],()=>true);
  await new Promise(r=>setImmediate(r));deepStrictEqual(shown,['PREPARING',2]);
  slow.resolve('graph');deepStrictEqual(await job,['Plans: HTTP 500']);deepStrictEqual(shown,['PREPARING',2,'graph']);
});
test('cancelled request cannot overwrite a newer view and a failed refresh does not poison the next one',async()=>{
  const slow=deferred();let current=true,applied=0;
  const job=refreshSections([section('State',()=>slow.promise,()=>applied++)],()=>current);
  current=false;slow.resolve('old');await job;strictEqual(applied,0);
  const gate=new RefreshGate();await rejects(gate.run(async()=>{throw Error('offline');}),/offline/);
  await gate.run(async()=>{applied++;});strictEqual(applied,1);
});
test('HTTP reads receive a finite timeout/abort signal and report endpoint + status on server failure',async()=>{
  const original=globalThis.fetch;let signal;
  globalThis.fetch=async(_path,init)=>{signal=init.signal;return new Response(JSON.stringify({error:'Internal server error'}),{status:500});};
  try{await rejects(getJson('/api/plans'),/\/api\/plans · HTTP 500/);ok(signal instanceof AbortSignal);}
  finally{globalThis.fetch=original;}
});
