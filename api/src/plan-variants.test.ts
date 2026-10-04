import {test} from 'node:test';
import {deepStrictEqual,strictEqual,ok,throws} from 'node:assert';
import {buildBalancedPlan,planMetrics,swapPlan,serializePlan,loadVariant} from './plan-variants.js';
import {DAY} from './campaign-plan.js';
import type {PlanVariant} from '@prisma/client';

test('balanced generators bound original-stake steps and branching across sizes, durations and seeds',()=>{
  for(const n of [2,3,4,9,17])for(const days of [18,36,60])for(let seed=0;seed<8;seed++){
    const members=Array.from({length:n},(_,i)=>({address:`W${i}`,ordinal:i}));
    const {metrics}=buildBalancedPlan(members,`${n}:${days}:${seed}`,new Date('2026-10-04'),days);
    ok(metrics.balanced);ok(metrics.distinct);
    for(const o of metrics.owners){
      ok(o.steps>=metrics.steps.lower&&o.steps<=metrics.steps.upper);
      ok(o.splits>=metrics.splits.lower&&o.splits<=metrics.splits.upper);
      strictEqual(o.mixSends,days-8);ok(o.returnSends<=8);
    }
  }
});
test('role exchange is a global ownership-preserving permutation; a second exchange restores the original',()=>{
  const members=Array.from({length:17},(_,i)=>({address:`W${i}`,ordinal:i})),anchor=new Date('2026-10-04');
  const {plan,metrics}=buildBalancedPlan(members,'swapping',anchor);
  const swapped=swapPlan(members,plan,'W1','W15'),after=planMetrics(members,swapped);
  strictEqual(after.owners[1].shape,metrics.owners[15].shape);
  strictEqual(after.owners[15].shape,metrics.owners[1].shape);
  strictEqual(after.balanced,true);
  deepStrictEqual(swapPlan(members,swapped,'W1','W15'),plan);
  const v={id:'v',number:1,totalDays:36,anchorAt:anchor,deadlineAt:new Date(anchor.getTime()+42*DAY),createdAt:anchor,
    membersJson:JSON.stringify(members),planJson:serializePlan(swapped,anchor),metricsJson:JSON.stringify(after),
    generatorVersion:2,parentId:null,sourceCampaignId:null} satisfies PlanVariant;
  const loaded=loadVariant(v,new Date(anchor.getTime()+DAY));
  strictEqual(loaded.plan.steps[0].plannedAt.getTime(),swapped.steps[0].plannedAt.getTime()+DAY);
  deepStrictEqual(loaded.plan.steps[0].allocations,swapped.steps[0].allocations);
  throws(()=>swapPlan(members,plan,'W1','W1'),/different/);
  const damaged=JSON.parse(v.planJson);damaged.steps[0].allocations[0].amountSun++;
  throws(()=>loadVariant({...v,planJson:JSON.stringify(damaged)}),/Invalid saved|Allocation/);
});
