import {test} from 'node:test';
import {deepStrictEqual,strictEqual,throws} from 'node:assert';
import {settle,settlementPlan} from './settlement.js';
test('exact grouping beats a naive greedy route',()=>{
  const b=[3,2,0,0,0].map((x,i)=>({address:String(i),sun:x*1_000_000}));
  const steps=settle(b);strictEqual(steps.length,3);
  for(const s of steps){const from=b.find(w=>w.address===s.from)!,to=b.find(w=>w.address===s.to)!;from.sun-=s.amountSun;to.sun+=s.amountSun;}
  deepStrictEqual(b.map(x=>x.sun),[1,1,1,1,1].map(x=>x*1_000_000));
});
test('rejects missing Sun',()=>throws(()=>settle([{address:'a',sun:999999}])));
test('pays exactly 1 TRX per entrant and leaves each original dust reserve untouched',()=>{
  const balances=[{address:'a',sun:1_100_007,reserveSun:7},{address:'b',sun:850_004,reserveSun:4},{address:'c',sun:1_050_000,reserveSun:0}];
  const steps=settlementPlan(balances,'teacher');let teacher=0;
  for(const step of steps){
    const sender=balances.find(w=>w.address===step.from)!;
    strictEqual(sender.sun>=step.amountSun,true);
    sender.sun-=step.amountSun;
    if(step.to==='teacher')teacher+=step.amountSun;
    else balances.find(w=>w.address===step.to)!.sun+=step.amountSun;
  }
  strictEqual(steps.filter(s=>s.kind==='PAYOUT').length,3);
  strictEqual(teacher,3_000_000);
  deepStrictEqual(balances.map(w=>w.sun),[7,4,0]);
});
test('refuses to settle an underfunded joined pool',()=>throws(()=>settlementPlan([{address:'a',sun:999_999,reserveSun:0}],'teacher')));
