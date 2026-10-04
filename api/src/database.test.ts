import {test} from 'node:test';
import {strictEqual,deepStrictEqual,rejects,ok} from 'node:assert';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {createDatabase} from './database.js';

async function fixture(){
  const directory=await mkdtemp(join(process.cwd(),'.database-test-'));
  const migrations=(await readdir('prisma/migrations',{withFileTypes:true})).filter(f=>f.isDirectory()).map(f=>f.name).sort();
  const sql=(await Promise.all(migrations.map(m=>readFile(`prisma/migrations/${m}/migration.sql`,'utf8')))).join('\n');
  const path=join(directory,'pool.db');
  execFileSync('python3',['-c','import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executescript(sys.argv[2]);c.close()',path,sql]);
  const db=createDatabase({datasourceUrl:`file:${path}`});
  return {db,async close(){await db.$disconnect();await rm(directory,{recursive:true,force:true});}};
}

test('SQLite queues concurrent transactions and standalone writes, preserves rollback and continues after rejection',async()=>{
  const f=await fixture();
  try{
    await f.db.engineState.create({data:{id:1,teacherAddress:'teacher',teacherBaseline:0}});
    let inside=0,maxInside=0;
    const work=Array.from({length:40},(_,i)=>i%2?
      f.db.engineState.update({where:{id:1},data:{teacherBaseline:{increment:1}}}):
      f.db.$transaction(async tx=>{
        inside++;maxInside=Math.max(maxInside,inside);
        try{await tx.engineState.update({where:{id:1},data:{teacherBaseline:{increment:1}}});
          await new Promise(r=>setTimeout(r,3));return await tx.engineState.findUniqueOrThrow({where:{id:1}});
        }finally{inside--;}
      }));
    await Promise.all(work);strictEqual(maxInside,1);
    strictEqual((await f.db.engineState.findUniqueOrThrow({where:{id:1}})).teacherBaseline,40);
    await rejects(f.db.$transaction(async tx=>{
      await tx.engineState.update({where:{id:1},data:{teacherBaseline:999}});throw Error('rollback intentionally');
    }),/rollback intentionally/);
    await f.db.engineState.update({where:{id:1},data:{teacherBaseline:{increment:1}}});
    strictEqual((await f.db.engineState.findUniqueOrThrow({where:{id:1}})).teacherBaseline,41);
    const batch=await f.db.$transaction([
      f.db.audit.create({data:{event:'BATCH_A',detail:'one'}}),f.db.audit.create({data:{event:'BATCH_B',detail:'two'}})
    ]);
    deepStrictEqual(batch.map(a=>a.event),['BATCH_A','BATCH_B']);
    await rejects(f.db.$transaction(async()=>f.db.$transaction(async()=>null)),/Nested transactions/);
    strictEqual(await f.db.audit.count(),2);
  }finally{await f.close();}
});

test('17-wallet dashboard/report reads, engine verification and Telegram ingestion coexist without database timeouts or broadcasts',async()=>{
  process.env.TRON_MODE='mock';
  const {loadConfig}=await import('./config.js');
  const {EngineService}=await import('./engine.js');
  const {TronService}=await import('./tron.js');
  const {TelegramService}=await import('./telegram.js');
  const {campaignSummary,ownerReport}=await import('./campaign-report.js');
  const {variantList}=await import('./plan-variants.js');
  const {verifyOwnership}=await import('./ownership.js');
  const f=await fixture(),config=await loadConfig(),engine=new EngineService(f.db,new TronService(f.db,config),config,true);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:{message_id:22}}));
  try{
    await engine.init();engine.stop();
    for(const w of config.wallets)await engine.setMixEnabled(w.address,true);
    await engine.generatePlan();await engine.startCampaign();
    const state=await f.db.engineState.findUniqueOrThrow({where:{id:1}});
    const worker=new TelegramService(f.db,{botToken:'test:only',channelId:'test',pinnedMessageId:1});
    await worker.bootstrap();
    const first=await f.db.transfer.findFirstOrThrow({orderBy:{sequence:'asc'}});
    await f.db.audit.createMany({data:Array.from({length:250},(_,i)=>({event:'QUEUED',detail:`concurrent audit ${i}`,transferId:first.id}))});
    const pending=[worker.runOnce(),engine.tick(),...Array.from({length:24},(_,i)=>Promise.all([
      campaignSummary(f.db),variantList(f.db),ownerReport(f.db,config.wallets[i%17].address),verifyOwnership(f.db,state.activeCampaignId!)
    ])),...Array.from({length:12},(_,i)=>f.db.audit.create({data:{event:'CONCURRENT',detail:String(i)}}))];
    const outcomes=await Promise.allSettled(pending);
    ok(outcomes.every(o=>o.status==='fulfilled'),JSON.stringify(outcomes.filter(o=>o.status==='rejected')));
    for(let i=0;i<3;i++)await worker.runOnce();
    strictEqual(await f.db.telegramDelivery.count(),262,'No audit skipped or duplicated by concurrent ingestion');
    strictEqual(await f.db.transfer.count({where:{txId:{not:null}}}),0);
    strictEqual((await f.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'CAMPAIGN');
    strictEqual((await verifyOwnership(f.db,state.activeCampaignId!)).length,17);
    const routes=await f.db.transfer.findMany({orderBy:{sequence:'asc'},select:{id:true,sequence:true,from:true,to:true,amountSun:true,plannedAt:true,allocations:true}});
    const adaptive=await Promise.allSettled([engine.accelerateCampaign(),worker.runOnce(),
      ...Array.from({length:24},(_,i)=>Promise.all([
        campaignSummary(f.db),variantList(f.db),ownerReport(f.db,config.wallets[i%17].address,undefined,{includePrehistory:i%2===0}),verifyOwnership(f.db,state.activeCampaignId!)
      ]))]);
    ok(adaptive.every(o=>o.status==='fulfilled'),adaptive.filter(o=>o.status==='rejected').map(o=>String(o.reason)).join('\n'));
    await worker.runOnce();
    strictEqual(await f.db.telegramDelivery.count(),263,'The timing change is logged once without skipping earlier events');
    strictEqual((await f.db.campaign.findUniqueOrThrow({where:{id:state.activeCampaignId!}})).timingMode,'BANDWIDTH');
    deepStrictEqual(await f.db.transfer.findMany({orderBy:{sequence:'asc'},select:{id:true,sequence:true,from:true,to:true,amountSun:true,plannedAt:true,allocations:true}}),routes);
    strictEqual(await f.db.transfer.count({where:{txId:{not:null}}}),0,'Timing forecasts cannot create approvals or broadcasts');
  }finally{engine.stop();globalThis.fetch=originalFetch;await f.close();}
});
