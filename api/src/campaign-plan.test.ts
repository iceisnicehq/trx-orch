import {test} from 'node:test';
import {deepStrictEqual,strictEqual,ok,throws} from 'node:assert';
import {buildCampaignPlan,UNIT} from './campaign-plan.js';
import {ownershipFlow,shapeSignature} from './campaign-report.js';
import {replayOwnership,attributedReturns} from './ownership.js';
import {approvalQueue} from './queue.js';

test('complete plans conserve every attributed Sun, respect profiles and equal daily mixing budgets',()=>{
  for(const n of [2,3,4,9,17])for(let seed=0;seed<12;seed++){
    const members=Array.from({length:n},(_,i)=>({address:`wallet${i}`,ordinal:i}));
    const plan=buildCampaignPlan(members,`${n}:${seed}`,new Date('2026-10-04T10:00:00Z'));
    const rows=plan.steps.map((s,i)=>({...s,id:String(i),sequence:i+1,status:'PLANNED',campaignDay:s.day}));
    const final=replayOwnership(members.map(m=>m.address),rows);
    strictEqual(final.length,n);
    for(const p of final){strictEqual(p.ownerAddress,p.holderAddress);strictEqual(p.amountSun,1_000_000);}
    for(const member of members)strictEqual(rows.filter(t=>t.kind==='MIX'&&t.from===member.address).length,28);
    for(const day of new Set(rows.map(r=>r.day))){const dayRows=rows.filter(r=>r.day===day);strictEqual(new Set(dayRows.map(r=>r.from)).size,dayRows.length);}
    // Arbitrary interruption, including the middle of an unequal-balance
    // cycle, can return original shares without relying on future inflows.
    for(const prefix of [1,Math.floor(rows.length/3),rows.filter(r=>r.kind==='MIX').length+1]){
      const executed=rows.slice(0,prefix),positions=replayOwnership(members.map(m=>m.address),executed);
      const closing=attributedReturns(positions).map((r,i)=>({...r,id:`r${i}`,sequence:rows.length+i,status:'PLANNED'}));
      const restored=replayOwnership(members.map(m=>m.address),[...executed,...closing]);
      for(const p of restored){strictEqual(p.ownerAddress,p.holderAddress);strictEqual(p.amountSun,1_000_000);}
    }
    for(let owner=0;owner<n;owner++){
      const profile=plan.profiles[owner];
      const owned=rows.flatMap(r=>r.allocations.filter(a=>a.ownerAddress===members[owner].address).map(a=>({r,a})));
      if(profile.type!=='EIGHTHS')ok(owned.every(({a})=>a.amountSun%(UNIT*2)===0));
      if(profile.type==='LATE_QUARTERS')ok(owned.filter(({r})=>r.day<profile.quarterDay).every(({a})=>a.amountSun%(UNIT*4)===0));
      const flow=ownershipFlow(members[owner].address,rows);
      for(const node of flow.nodes){
        const incoming=flow.edges.filter(e=>e.to===node.id).reduce((s,e)=>s+e.amountSun,0);
        const outgoing=flow.edges.filter(e=>e.from===node.id).reduce((s,e)=>s+e.amountSun,0);
        if(node.id!=='root')strictEqual(incoming,node.amountSun,'Diagram must conserve amount at every merge');
        if(outgoing)strictEqual(outgoing,node.amountSun,'Diagram must conserve amount at every split');
      }
    }
  }
});

test('stable seed gives a reproducible plan with multi-owner packets and distinct graph structures',()=>{
  const members=Array.from({length:17},(_,i)=>({address:`W${i}`,ordinal:i}));
  const one=buildCampaignPlan(members,'test',new Date('2026-10-04T10:00:00Z'));
  deepStrictEqual(one,buildCampaignPlan(members,'test',new Date('2026-10-04T10:00:00Z')));
  ok(one.steps.some(t=>t.allocations.length>=4));
  ok(one.steps.some(t=>t.allocations.length>=6));
  const rows=one.steps.map((s,i)=>({...s,id:String(i),sequence:i+1,status:'PLANNED',campaignDay:s.day}));
  strictEqual(new Set(members.map(m=>shapeSignature(ownershipFlow(m.address,rows)))).size,17);
  ok(new Set(one.profiles.map(p=>p.releaseDay)).size>3);
  throws(()=>buildCampaignPlan(members.slice(0,1),'x',new Date()),/2–17/);
  throws(()=>buildCampaignPlan(members,'x',new Date(),4),/18–60/);
  throws(()=>replayOwnership(members.map(m=>m.address),[{...rows[0],allocations:[{ownerAddress:'W0',amountSun:-1}]}]),/Allocation total/);
});

test('approval desk shows one nearest campaign transaction per sender without hiding legacy recovery rows',()=>{
  const rows=[{campaignId:'a',from:'W1',sequence:2},{campaignId:'a',from:'W1',sequence:5},
    {campaignId:'a',from:'W2',sequence:3},{campaignId:null,from:'W1',sequence:1}];
  deepStrictEqual(approvalQueue(rows).map(r=>r.sequence),[1,2,3]);
});
