import {test} from 'node:test';
import {strictEqual,deepStrictEqual,ok} from 'node:assert';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {createDatabase} from './database.js';
import {ownerReport,reportCsv,variantOwnerReport,includeReportPrehistory} from './campaign-report.js';
import {historicalModes} from './report-prehistory.js';
import {buildCampaignPlan} from './campaign-plan.js';
import {saveVariant} from './plan-variants.js';

const at=new Date('2026-10-04T10:00:00.000Z');
const profile=JSON.stringify({type:'QUARTERS',releaseDay:1,quarterDay:2,eighthDay:null});
async function fixture(){
  const directory=await mkdtemp(join(process.cwd(),'.prehistory-test-'));
  const names=(await readdir('prisma/migrations',{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
  const sql=(await Promise.all(names.map(n=>readFile(`prisma/migrations/${n}/migration.sql`,'utf8')))).join('\n');
  const path=join(directory,'pool.db');
  execFileSync('python3',['-c','import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executescript(sys.argv[2]);c.close()',path,sql]);
  const db=createDatabase({datasourceUrl:`file:${path}`});
  const members=['A','B','C'].map((address,ordinal)=>({address,ordinal}));
  await db.wallet.createMany({data:[...members,{address:'D',ordinal:3},{address:'E',ordinal:4},{address:'F',ordinal:5}]});
  await db.engineState.create({data:{id:1,phase:'CAMPAIGN',activeCampaignId:'current',nextSequence:103,
    teacherAddress:'teacher',teacherBaseline:0,mixAmountMode:'SMART'}});
  for(const id of ['previous','current']){
    await db.campaign.create({data:{id,seed:id,startedAt:new Date(at.getTime()-(id==='previous'?86_400_000:0)),
      deadlineAt:new Date(at.getTime()+42*86_400_000),mixingDays:28,totalDays:36,members:{create:members.map(m=>({...m,profileJson:profile}))}}});
  }
  const history=[
    {sequence:1,from:'A',to:'B',amountSun:121535},
    {sequence:2,from:'B',to:'C',amountSun:74301},
    {sequence:3,from:'C',to:'A',amountSun:15941},
    {sequence:4,from:'A',to:'B',amountSun:500000},
    {sequence:5,from:'B',to:'C',amountSun:1000000},
    {sequence:6,from:'C',to:'A',amountSun:605594,kind:'REBALANCE'},
    {sequence:7,from:'C',to:'B',amountSun:452766,kind:'REBALANCE'},
    {sequence:8,from:'D',to:'E',amountSun:500000}
  ];
  for(const row of history){
    const recorded=new Date(at.getTime()-2*86_400_000+row.sequence*60_000);
    await db.transfer.create({data:{...row,id:`old-${row.sequence}`,kind:row.kind??'MIX',status:'CONFIRMED',
      scheduledAt:row.sequence===3?new Date(recorded.getTime()-60_000):recorded,createdAt:recorded,updatedAt:recorded,confirmedAt:row.sequence===3?null:recorded,
      txId:`tx-old-${row.sequence}`,bandwidthUsed:row.sequence===3?null:267}});
  }
  await db.audit.createMany({data:[
    {event:'QUEUED',detail:'MIX 121535 Sun A → B',transferId:'old-1'},
    {event:'QUEUED',detail:'MIX 74301 Sun B → C',transferId:'old-2'},
    {event:'QUEUED',detail:'MIX 15941 Sun C → A',transferId:'old-3'},
    {event:'PLAN',detail:'3 transfers added within the next 24 hours; one pending MIX per sender'},
    {event:'MIX_AMOUNT_MODE',detail:'LIST; list 0.5 TRX, 1 TRX; prior unsent approvals cancelled'},
    {event:'QUEUED',detail:'MIX 500000 Sun A → B',transferId:'old-4'},
    {event:'QUEUED',detail:'MIX 1000000 Sun B → C',transferId:'old-5'}
  ]});
  for(const [i,status] of ['CANCELLED','PLANNED','SUBMITTED','UNKNOWN'].entries()){
    await db.transfer.create({data:{id:`not-confirmed-${status}`,sequence:9+i,kind:'MIX',status,from:'A',to:'B',amountSun:1,scheduledAt:at}});
  }
  const previous=[
    {sequence:13,kind:'MIX',from:'B',to:'A',amountSun:125000,allocations:[{ownerAddress:'B',amountSun:125000}]},
    {sequence:14,kind:'MIX',from:'A',to:'C',amountSun:250000,allocations:[{ownerAddress:'A',amountSun:125000},{ownerAddress:'B',amountSun:125000}]},
    {sequence:15,kind:'RETURN',from:'C',to:'B',amountSun:125000,allocations:[{ownerAddress:'B',amountSun:125000}]},
    {sequence:16,kind:'RETURN',from:'C',to:'A',amountSun:125000,allocations:[{ownerAddress:'A',amountSun:125000}]}
  ];
  for(const {allocations,...row} of previous){
    const recorded=new Date(at.getTime()-86_400_000+row.sequence*60_000);
    await db.transfer.create({data:{...row,id:`previous-${row.sequence}`,campaignId:'previous',campaignDay:1,status:'CONFIRMED',
      scheduledAt:recorded,plannedAt:recorded,confirmedAt:recorded,bandwidthUsed:267,txId:`tx-previous-${row.sequence}`,allocations:{create:allocations}}});
  }
  for(const [i,[from,to]] of [['A','B'],['B','C'],['C','A']].entries()){
    await db.transfer.create({data:{id:`current-${i}`,sequence:100+i,kind:i===2?'RETURN':'MIX',status:'PLANNED',from,to,amountSun:500000,
      campaignId:'current',campaignDay:1+i,scheduledAt:new Date(at.getTime()+(i+1)*86_400_000),plannedAt:new Date(at.getTime()+(i+1)*86_400_000),
      allocations:{create:{ownerAddress:'A',amountSun:500000}}}});
  }
  return {db,members,async close(){await db.$disconnect();await rm(directory,{recursive:true,force:true});}};
}

function csvRows(csv:string){
  const lines=csv.replace(/^\uFEFF/,'').trimEnd().split('\r\n');
  const cells=(line:string)=>[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m=>m[1].replaceAll('""','"'));
  const header=cells(lines[0]);return lines.slice(1).map(line=>{
    const values=cells(line);strictEqual(values.length,header.length,'All CSV rows must align with the header');
    return Object.fromEntries(header.map((h,i)=>[h,values[i]]));
  });
}

test('historical mode comes from the queue audit, including missing-mode fallback',()=>{
  const modes=historicalModes([
    {id:7,event:'QUEUED',detail:'',transferId:'missing'},
    {id:3,event:'PLAN',detail:'LIST step 1.0 TRX A → B; next step waits for this receipt',transferId:null},
    {id:2,event:'QUEUED',detail:'',transferId:'list'},
    {id:1,event:'MIX_AMOUNT_MODE',detail:'LIST; list 1 TRX',transferId:null},
    {id:4,event:'MIX_AMOUNT_MODE',detail:'RANDOM; list 1 TRX',transferId:null},
    {id:5,event:'QUEUED',detail:'',transferId:'random'},
    {id:6,event:'MIX_AMOUNT_MODE',detail:'unrecognised older event',transferId:null}
  ]);
  strictEqual(modes.get('list'),'LIST');strictEqual(modes.get('random'),'RANDOM');
  strictEqual(historicalModes([{id:1,event:'QUEUED',detail:'1 TRX A → B',transferId:'x'}]).get('x'),'LEGACY');
});

test('optional prehistory includes peer hops and Rebalance, excludes unrelated and unconfirmed transfers, and never changes the live plan',async()=>{
  const f=await fixture();
  try{
    const before={transfers:await f.db.transfer.findMany({orderBy:{sequence:'asc'},include:{allocations:true}}),
      state:await f.db.engineState.findUniqueOrThrow({where:{id:1}}),audit:await f.db.audit.count()};
    const plain=await ownerReport(f.db,'A');ok(plain);strictEqual(plain.prehistory,null);
    const report=await ownerReport(f.db,'A',undefined,{includePrehistory:true});ok(report?.prehistory);
    deepStrictEqual(report.prehistory.events.map(t=>t.sequence),[1,2,3,4,5,6,7,13,14,15,16]);
    strictEqual(report.prehistory.events.find(t=>t.sequence===2)!.from,'B','Keep peer-to-peer history beyond the origin address');
    strictEqual(report.prehistory.events.find(t=>t.sequence===1)!.legacyMode,'RANDOM');
    strictEqual(report.prehistory.events.find(t=>t.sequence===5)!.legacyMode,'LIST');
    strictEqual(report.prehistory.events.filter(t=>t.kind==='REBALANCE').length,2);
    strictEqual(report.prehistory.unrecordedCount,7);
    ok(report.prehistory.events.slice(0,7).every(t=>t.ownerSun===null&&t.fromComposition===null&&t.toComposition===null));
    strictEqual(report.prehistory.events.find(t=>t.sequence===14)!.ownerSun,125000,'Existing frozen allocations are retained');
    strictEqual(report.prehistory.events.find(t=>t.sequence===13)!.ownerSun,0,'A recorded zero share differs from an unknown share');
    deepStrictEqual(report.events,plain.events);deepStrictEqual(report.positions,plain.positions);deepStrictEqual(report.finalPositions,plain.finalPositions);
    strictEqual(report.shapeSignature,plain.shapeSignature);strictEqual(report.flow.splits,plain.flow.splits);strictEqual(report.flow.merges,plain.flow.merges);
    const ranks=new Map(report.flow.nodes.map(n=>[n.id,n.rank]));
    strictEqual(ranks.size,report.flow.nodes.length,'Context IDs cannot collide with SMART IDs');
    for(const edge of report.flow.edges)ok(ranks.get(edge.from)!<ranks.get(edge.to)!,'Every arrow points forward');
    ok(report.flow.edges.filter(e=>e.status==='CONTEXT').every(e=>e.amountSun===null));
    ok(report.flow.nodes.filter(n=>n.section==='PREHISTORY'&&n.type==='holding').every(n=>n.amountSun===null));
    strictEqual(report.flow.nodes.filter(n=>n.type==='checkpoint').length,1,'The bridge is a checkpoint, not a synthetic transaction');
    const after={transfers:await f.db.transfer.findMany({orderBy:{sequence:'asc'},include:{allocations:true}}),
      state:await f.db.engineState.findUniqueOrThrow({where:{id:1}}),audit:await f.db.audit.count()};
    deepStrictEqual(after,before);ok(!JSON.stringify(report).includes('signedJson'));ok(!JSON.stringify(report).includes('privateKey'));
  }finally{await f.close();}
});

test('CSV prehistory is optional and preserves every decimal Sun, full route, receipt and unknown field',async()=>{
  const f=await fixture();
  try{
    const plain=await ownerReport(f.db,'A');ok(plain);
    const report=await ownerReport(f.db,'A',undefined,{includePrehistory:true});ok(report);
    const without=csvRows(reportCsv(plain)),withHistory=csvRows(reportCsv(report));
    strictEqual(without.length,3);ok(without.every(row=>row.report_section==='CAMPAIGN'));
    strictEqual(withHistory.length,14);
    const first=withHistory[0];strictEqual(first.native_amount_sun,'121535');strictEqual(first.native_amount_trx,'0.121535');
    strictEqual(first.owner_amount_sun,'');strictEqual(first.owner_amount_trx,'');strictEqual(first.packet_ownership,'');
    strictEqual(first.from_game_balance_after_sun,'');strictEqual(first.from_wallet_ownership_after,'');
    strictEqual(first.attribution_basis,'UNRECORDED');strictEqual(first.transfer_mode,'RANDOM');strictEqual(first.tx_id,'tx-old-1');
    strictEqual(first.from_address,'A');strictEqual(first.to_address,'B');strictEqual(first.bandwidth_whole_transaction,'267');
    const missing=withHistory.find(row=>row.sequence==='3')!;
    strictEqual(missing.confirmed_utc,'');strictEqual(missing.bandwidth_whole_transaction,'');ok(missing.recorded_confirmation_utc);
    strictEqual(missing.execution_time_basis,'RECORD');ok(missing.execution_msk.includes('MSK'));
    ok(missing.recorded_confirmation_utc!==missing.scheduled_utc,'A planned date must not be presented as actual confirmation');
    strictEqual(first.execution_time_basis,'BLOCK');
    const list=withHistory.find(row=>row.sequence==='5')!;strictEqual(list.native_amount_trx,'1.000000');strictEqual(list.transfer_mode,'LIST');
    const balancing=withHistory.find(row=>row.sequence==='6')!;strictEqual(balancing.transfer_mode,'REBALANCE');strictEqual(balancing.native_amount_sun,'605594');
    const older=withHistory.find(row=>row.sequence==='14')!;strictEqual(older.attribution_basis,'RECORDED');strictEqual(older.owner_amount_sun,'125000');strictEqual(older.source_campaign_id,'previous');
    deepStrictEqual(withHistory.filter(row=>row.report_section==='CAMPAIGN'),without);
  }finally{await f.close();}
});

test('archived reports stop at their own start and newly funded wallets get no fabricated prehistory',async()=>{
  const f=await fixture();
  try{
    await f.db.transfer.create({data:{id:'later-legacy',sequence:200,kind:'MIX',status:'CONFIRMED',from:'A',to:'B',amountSun:10000,scheduledAt:at,confirmedAt:at}});
    await f.db.engineState.update({where:{id:1},data:{nextSequence:201}});
    const current=await ownerReport(f.db,'A','current',{includePrehistory:true});ok(current?.prehistory);
    ok(current.prehistory.events.every(t=>t.sequence<100));
    const previous=await ownerReport(f.db,'A','previous',{includePrehistory:true});ok(previous?.prehistory);
    deepStrictEqual(previous.prehistory.events.map(t=>t.sequence),[1,2,3,4,5,6,7]);
    const plan=buildCampaignPlan([{address:'F',ordinal:5},{address:'E',ordinal:4}],'fresh',at);
    const variant=await saveVariant(f.db,[{address:'F',ordinal:5},{address:'E',ordinal:4}],plan,at,new Date(at.getTime()+42*86_400_000));
    const draft=variantOwnerReport(variant,'F');ok(draft);
    const withHistory=await includeReportPrehistory(f.db,draft);
    deepStrictEqual(withHistory.prehistory.events,[]);deepStrictEqual(withHistory.flow,draft.flow);
  }finally{await f.close();}
});

test('saved-plan previews can include prior receipts without creating or copying approvals',async()=>{
  const f=await fixture();
  try{
    const plan=buildCampaignPlan(f.members,'preview',at);
    const variant=await saveVariant(f.db,f.members,plan,at,new Date(at.getTime()+42*86_400_000));
    const draft=variantOwnerReport(variant,'A');ok(draft);
    const before=await f.db.transfer.findMany({orderBy:{sequence:'asc'}});
    const report=await includeReportPrehistory(f.db,draft);
    ok(report.prehistory.events.length>0);ok(report.events.every(t=>t.status==='DRAFT'));
    ok(csvRows(reportCsv(report)).some(t=>t.report_section==='PREHISTORY'));
    deepStrictEqual(report.events,draft.events);deepStrictEqual(await f.db.transfer.findMany({orderBy:{sequence:'asc'}}),before);
  }finally{await f.close();}
});
