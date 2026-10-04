import {test} from 'node:test';
import {strictEqual,deepStrictEqual,rejects} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {PrismaClient} from '@prisma/client';
import {createDatabase} from './database.js';

test('fixed amount chain, rebalance recovery, and end-game map after rebalance',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'.rebalance-test-'));
  process.env.TRON_MODE='mock';
  process.env.DATABASE_URL=`file:${join(directory,'pool.db')}`;
  let db:PrismaClient|undefined;
  try{
    const migrations=['20260926000000_init','20260928000000_dynamic_members',
      '20260929000000_bandwidth_receipts','20260929010000_bandwidth_block_time',
      '20260929020000_telegram_notifications','20260929030000_rebalance_and_amount_modes',
      '20260930000000_external_extra_reserves'];
    const sql=(await Promise.all(migrations.map(dir=>readFile(`prisma/migrations/${dir}/migration.sql`,'utf8')))).join('\n');
    execFileSync('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',join(directory,'pool.db'),sql+'\n'+await readFile('prisma/migrations/20261004000000_campaign_ownership/migration.sql','utf8')+'\n'+await readFile('prisma/migrations/20261004010000_plan_variants/migration.sql','utf8')]);
    const [{loadConfig,TARGET},{TronService},{EngineService}]=await Promise.all([
      import('./config.js'),import('./tron.js'),import('./engine.js')
    ]);
    const config=await loadConfig();
    db=createDatabase();
    const tron=new TronService(db,config),engine=new EngineService(db,tron,config);
    await engine.init();
    const members=config.wallets.slice(0,3);
    for(let i=0;i<members.length;i++){
      await db.wallet.update({where:{address:members[i].address},data:{balanceSnapshotSun:TARGET+[7,4,0][i]}});
      await engine.setMixEnabled(members[i].address,true);
    }
    await engine.start();
    const earlier=await db.transfer.findMany({where:{kind:'MIX',status:'PLANNED'}});
    strictEqual(earlier.length,3);
    await rejects(engine.setMixAmounts('LIST',[700_000]),/List must contain/);
    await engine.setMixAmounts('LIST',[TARGET,TARGET/2]);
    strictEqual(await db.transfer.count({where:{id:{in:earlier.map(t=>t.id)},status:'CANCELLED'}}),3);
    let next=await db.transfer.findMany({where:{kind:'MIX',status:'PLANNED'}});
    strictEqual(next.length,1);
    strictEqual(next[0].amountSun,TARGET);
    const first=next[0];
    await db.transfer.update({where:{id:first.id},data:{scheduledAt:new Date(Date.now()-1000)}});
    await engine.approve(first.id);
    const pendingPreview=await engine.rebalancePreview();
    strictEqual(pendingPreview.pendingReceipt,true);
    strictEqual(pendingPreview.transferCount,null);
    await engine.tick();
    const confirmed=await db.transfer.findUniqueOrThrow({where:{id:first.id}});
    strictEqual(confirmed.status,'CONFIRMED');
    strictEqual(confirmed.bandwidthUsed,260);
    const state=await db.engineState.findUniqueOrThrow({where:{id:1}});
    strictEqual(state.mixAmountCursor,1);
    next=await db.transfer.findMany({where:{kind:'MIX',status:'PLANNED'}});
    strictEqual(next.length,1);
    strictEqual(next[0].from,confirmed.to,'The confirmed recipient continues the chain');
    strictEqual(next[0].amountSun,TARGET/2);
    const preview=await engine.rebalancePreview();
    strictEqual(preview.pendingReceipt,false);
    strictEqual(preview.transferCount,1);
    strictEqual(preview.steps[0].amountSun,TARGET);
    await engine.rebalance();
    strictEqual((await db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'REBALANCING');
    strictEqual((await db.transfer.findUniqueOrThrow({where:{id:next[0].id}})).status,'CANCELLED');
    const rebalances=await db.transfer.findMany({where:{kind:'REBALANCE'}});
    strictEqual(rebalances.length,1);
    strictEqual(rebalances[0].amountSun,TARGET);
    let worker=new EngineService(db,tron,config);
    await worker.init();
    strictEqual(await db.transfer.count({where:{kind:'REBALANCE'}}),1);
    await worker.approve(rebalances[0].id);
    await db.transfer.update({where:{id:rebalances[0].id},data:{status:'SUBMITTING'}});
    worker=new EngineService(db,tron,config);
    await worker.init();
    strictEqual((await db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'MIXING');
    strictEqual(await db.audit.count({where:{event:'REBALANCE_COMPLETE'}}),1);
    deepStrictEqual(await Promise.all(members.map(async(w,i)=>(await db!.wallet.findUniqueOrThrow({where:{address:w.address}})).balanceSnapshotSun)),
      [TARGET+7,TARGET+4,TARGET]);
    const resumed=await db.transfer.findMany({where:{kind:'MIX',status:'PLANNED'}});
    strictEqual(resumed.length,1);
    strictEqual(resumed[0].amountSun,TARGET);
    await worker.end();
    const endState=await db.engineState.findUniqueOrThrow({where:{id:1}});
    strictEqual(endState.phase,'SETTLING');
    strictEqual(await db.transfer.count({where:{kind:'PAYOUT'}}),3);
    strictEqual(await db.transfer.count({where:{kind:'REBALANCE'}}),1,'Old rebalance must not be mistaken for the end-game map');
    await db.engineState.update({where:{id:1},data:{phase:'END_REQUESTED'}});
    worker=new EngineService(db,tron,config);
    await worker.init();
    strictEqual(await db.transfer.count({where:{kind:'PAYOUT'}}),3,'End-game restart must reuse only its own map');
  }finally{
    await db?.$disconnect();
    await rm(directory,{recursive:true,force:true});
  }
});

test('end during rebalance cancels its open map and creates a fresh payout map',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'.rebalance-end-test-'));
  process.env.TRON_MODE='mock';
  process.env.DATABASE_URL=`file:${join(directory,'pool.db')}`;
  let db:PrismaClient|undefined;
  try{
    const migrations=['20260926000000_init','20260928000000_dynamic_members',
      '20260929000000_bandwidth_receipts','20260929010000_bandwidth_block_time',
      '20260929020000_telegram_notifications','20260929030000_rebalance_and_amount_modes',
      '20260930000000_external_extra_reserves'];
    const sql=(await Promise.all(migrations.map(dir=>readFile(`prisma/migrations/${dir}/migration.sql`,'utf8')))).join('\n');
    execFileSync('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',join(directory,'pool.db'),sql+'\n'+await readFile('prisma/migrations/20261004000000_campaign_ownership/migration.sql','utf8')+'\n'+await readFile('prisma/migrations/20261004010000_plan_variants/migration.sql','utf8')]);
    const [{loadConfig,TARGET},{TronService},{EngineService}]=await Promise.all([
      import('./config.js'),import('./tron.js'),import('./engine.js')
    ]);
    const config=await loadConfig();
    db=createDatabase();
    const tron=new TronService(db,config),engine=new EngineService(db,tron,config);
    await engine.init();
    for(const w of config.wallets.slice(0,2)){
      await db.wallet.update({where:{address:w.address},data:{balanceSnapshotSun:TARGET}});
      await engine.setMixEnabled(w.address,true);
    }
    await engine.start();
    await engine.setMixAmounts('LIST',[TARGET]);
    const mix=await db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'PLANNED'}});
    await db.transfer.update({where:{id:mix.id},data:{scheduledAt:new Date(Date.now()-1000)}});
    await engine.approve(mix.id);
    await engine.tick();
    strictEqual((await db.transfer.findUniqueOrThrow({where:{id:mix.id}})).status,'CONFIRMED');
    await engine.rebalance();
    const old=await db.transfer.findFirstOrThrow({where:{kind:'REBALANCE',status:'PLANNED'}});
    await engine.end();
    strictEqual((await db.transfer.findUniqueOrThrow({where:{id:old.id}})).status,'CANCELLED');
    strictEqual((await db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'SETTLING');
    strictEqual(await db.transfer.count({where:{kind:'REBALANCE',status:'PLANNED'}}),1);
    strictEqual(await db.transfer.count({where:{kind:'PAYOUT',status:'PLANNED'}}),2);
    const restarted=new EngineService(db,tron,config);
    await restarted.init();
    strictEqual(await db.transfer.count({where:{kind:'PAYOUT'}}),2);
    strictEqual(await db.transfer.count({where:{kind:'REBALANCE'}}),2);
  }finally{
    await db?.$disconnect();
    await rm(directory,{recursive:true,force:true});
  }
});

test('LIST uses a funded high-bandwidth sender immediately and forecasts the soonest recovery otherwise',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'.list-readiness-test-'));
  process.env.TRON_MODE='mock';
  process.env.DATABASE_URL=`file:${join(directory,'pool.db')}`;
  let db:PrismaClient|undefined;
  try{
    const migrations=['20260926000000_init','20260928000000_dynamic_members',
      '20260929000000_bandwidth_receipts','20260929010000_bandwidth_block_time',
      '20260929020000_telegram_notifications','20260929030000_rebalance_and_amount_modes',
      '20260930000000_external_extra_reserves'];
    const sql=(await Promise.all(migrations.map(dir=>readFile(`prisma/migrations/${dir}/migration.sql`,'utf8')))).join('\n');
    execFileSync('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',join(directory,'pool.db'),sql+'\n'+await readFile('prisma/migrations/20261004000000_campaign_ownership/migration.sql','utf8')+'\n'+await readFile('prisma/migrations/20261004010000_plan_variants/migration.sql','utf8')]);
    const [{loadConfig,TARGET},{TronService},{EngineService}]=await Promise.all([
      import('./config.js'),import('./tron.js'),import('./engine.js')
    ]);
    const config=await loadConfig();
    db=createDatabase();
    const tron=new TronService(db,config),engine=new EngineService(db,tron,config);
    await engine.init();
    const members=config.wallets.slice(0,3);
    for(const w of members){
      await db.wallet.update({where:{address:w.address},data:{balanceSnapshotSun:TARGET}});
      await engine.setMixEnabled(w.address,true);
    }
    await engine.start();
    const free=new Map([[members[0].address,342],[members[1].address,600],[members[2].address,435]]);
    tron.bandwidthSnapshot=async(address:string)=>({available:free.get(address)??600,limit:600,observedAt:Date.now()});
    const startedAt=Date.now();
    await engine.setMixAmounts('LIST',[TARGET]);
    let next=await db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'PLANNED'}});
    strictEqual(next.from,members[1].address,'An enabled sender with 600 free Bandwidth goes before a sender with 342');
    strictEqual(next.to,members[2].address,'Prefer a receiver able to continue the chain promptly');
    strictEqual(next.scheduledAt.getTime()<startedAt+15_000,true,'A ready LIST sender has no artificial 1–2 hour gap');
    await engine.approve(next.id);
    strictEqual((await db.transfer.findUniqueOrThrow({where:{id:next.id}})).status,'SUBMITTED');
    await engine.tick();
    next=await db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'PLANNED'}});
    strictEqual(next.from,members[2].address,'The funded last recipient continues when it has enough Bandwidth');
    strictEqual(next.scheduledAt.getTime()<Date.now()+15_000,true,'No global one-hour gap blocks the next LIST step');
    free.set(members[2].address,390);
    await engine.replan();
    next=await db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'PLANNED'}});
    strictEqual(next.from,members[2].address,'With no ready sender, choose the soonest recovery');
    strictEqual(next.scheduledAt.getTime()>Date.now()+60*60_000,true,'Below 400, keep the recovery forecast and hour buffer');
    free.set(members[2].address,435);
    await engine.replan();
    next=await db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'PLANNED'}});
    await engine.approve(next.id);
    strictEqual((await db.transfer.findUniqueOrThrow({where:{id:next.id}})).status,'SUBMITTED',
      'A ready LIST transfer can broadcast after a recent MIX without the old global one-hour wait');
  }finally{
    await db?.$disconnect();
    await rm(directory,{recursive:true,force:true});
  }
});
