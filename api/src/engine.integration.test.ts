import {test} from 'node:test';
import {strictEqual,deepStrictEqual,rejects} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {PrismaClient} from '@prisma/client';
import {createDatabase} from './database.js';

test('two-wallet start, later join, replan, manual approvals and exact payouts',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'.testdb-'));
  process.env.TRON_MODE='mock';
  process.env.DATABASE_URL=`file:${join(directory,'pool.db')}`;
  let db:PrismaClient|undefined;
  try{
    // Apply the checked-in SQL directly for this local integration test. The
    // production image still applies these migrations with Prisma at boot.
    const migrations=(await readdir('prisma/migrations',{withFileTypes:true})).filter(f=>f.isDirectory()).map(f=>f.name).sort();
    const sql=(await Promise.all(migrations.map(dir=>readFile(`prisma/migrations/${dir}/migration.sql`,'utf8')))).join('\n');
    execFileSync('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',join(directory,'pool.db'),sql]);
    const [{loadConfig,TARGET},{TronService},{EngineService}]=await Promise.all([
      import('./config.js'),import('./tron.js'),import('./engine.js')
    ]);
    const config=await loadConfig();
    db=createDatabase();
    const tron=new TronService(db,config),engine=new EngineService(db,tron,config);
    await engine.init();
    const [one,two,three,...rest]=config.wallets;
    await db.wallet.update({where:{address:one.address},data:{balanceSnapshotSun:TARGET+7}});
    await db.wallet.update({where:{address:two.address},data:{balanceSnapshotSun:TARGET+4}});
    for(const w of rest.slice(-2))await db.wallet.update({where:{address:w.address},data:{balanceSnapshotSun:0}});
    await rejects(engine.start(),/Select at least two/);
    strictEqual((await db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'IDLE');
    await rejects(engine.setMixEnabled(rest.at(-1)!.address,true),/needs at least 1 TRX/);
    await engine.setMixEnabled(one.address,true);
    await engine.setMixEnabled(two.address,true);
    await engine.start();
    let queued=await db.transfer.findMany({where:{status:'PLANNED'},orderBy:{sequence:'asc'}});
    strictEqual(queued.length,2);
    strictEqual(new Set(queued.map(t=>t.from)).size,queued.length);
    strictEqual(queued.every(t=>[one.address,two.address].includes(t.from)&&[one.address,two.address].includes(t.to)),true);
    const firstPlanAt=(await db.engineState.findUniqueOrThrow({where:{id:1}})).lastPlanAt!.getTime();
    let previous=firstPlanAt;
    for(const row of queued){
      const gap=row.scheduledAt.getTime()-previous;
      strictEqual(gap>=60*60_000,true,`Unexpected planned gap: ${gap}`);
      strictEqual(row.scheduledAt.getTime()<firstPlanAt+24*60*60_000,true);
      previous=row.scheduledAt.getTime();
    }
    const originalIds=queued.map(t=>t.id);
    // Upgrade an older schedule with duplicate outbound rows. Earliest rows
    // (including an approval) survive; second rows and generic notes do not.
    await db.transfer.update({where:{id:queued[0].id},data:{status:'APPROVED',note:'Bandwidth forecast: scheduled after estimated recovery to 400 plus one hour; live resource check required'}});
    const firstApproved=queued[0].id;
    const stateBeforeUpgrade=await db.engineState.findUniqueOrThrow({where:{id:1}});
    const extraIds:string[]=[];
    for(let i=0;i<queued.length;i++){
      const row=queued[i];
      const extra=await db.transfer.create({data:{kind:'MIX',status:'APPROVED',from:row.from,to:row.to,amountSun:row.amountSun,
        sequence:stateBeforeUpgrade.nextSequence+i,scheduledAt:new Date(Date.now()+12*60*60_000),
        note:'Bandwidth forecast: scheduled after estimated recovery to 400 plus one hour; live resource check required'}});
      extraIds.push(extra.id);
    }
    await db.engineState.update({where:{id:1},data:{nextSequence:stateBeforeUpgrade.nextSequence+queued.length}});
    const upgraded=new EngineService(db,tron,config);
    await upgraded.init();
    const kept=await db.transfer.findMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED']}},orderBy:{sequence:'asc'}});
    deepStrictEqual(kept.map(row=>row.id),originalIds);
    strictEqual(kept[0].id,firstApproved);
    strictEqual(kept[0].status,'APPROVED');
    strictEqual(kept.every(row=>row.note===null),true);
    strictEqual(await db.transfer.count({where:{id:{in:extraIds},status:'CANCELLED'}}),extraIds.length);
    await engine.replan();
    strictEqual(await db.transfer.count({where:{id:{in:originalIds},status:'CANCELLED'}}),originalIds.length);
    queued=await db.transfer.findMany({where:{status:'PLANNED'},orderBy:{sequence:'asc'}});
    strictEqual(queued.length>0,true);
    strictEqual(queued.every(t=>!originalIds.includes(t.id)),true);
    // Start never sends a transaction while manual approval is still required.
    strictEqual(await db.transfer.count({where:{status:'CONFIRMED'}}),0);
    // Advance just the first predicted time in this mock test; live schedules
    // are never moved ahead when an administrator approves early.
    await db.transfer.update({where:{id:queued[0].id},data:{scheduledAt:new Date(Date.now()-1000)}});
    await engine.approve(queued[0].id);
    const originalReceipt=tron.receipt.bind(tron);
    tron.receipt=async()=>({found:false,success:false,feeSun:0,bandwidthUsed:null,confirmedAt:null});
    const pendingTx=await db.transfer.findUniqueOrThrow({where:{id:queued[0].id}});
    await engine.replan();
    strictEqual((await db.transfer.findUniqueOrThrow({where:{id:pendingTx.id}})).txId,pendingTx.txId);
    strictEqual(await db.transfer.count({where:{kind:'MIX',status:'PLANNED'}}),0);
    await engine.setMixEnabled(three.address,true);
    strictEqual((await db.wallet.findUniqueOrThrow({where:{address:three.address}})).joined,false);
    strictEqual((await db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'MIXING');
    tron.receipt=originalReceipt;
    // Simulate a crash after the network accepted the mix, before the database
    // recorded SUBMITTED. Startup must reconcile its persisted txID.
    await db.transfer.update({where:{id:queued[0].id},data:{status:'SUBMITTING'}});
    const {EngineService:RestartedEngine}=await import('./engine.js');
    const resumed=new RestartedEngine(db,tron,config);
    await resumed.init();
    strictEqual(await db.transfer.count({where:{kind:'MIX',status:'CONFIRMED'}}),1);
    const confirmedMix=await db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'CONFIRMED'}});
    strictEqual(confirmedMix.bandwidthUsed,260);
    strictEqual(confirmedMix.confirmedAt instanceof Date,true);
    strictEqual(await tron.availableBandwidth(confirmedMix.from),340);
    strictEqual((await tron.recentBandwidthSpends(confirmedMix.from))[0].points,260);
    const senderReplacement=await db.transfer.findMany({where:{kind:'MIX',from:confirmedMix.from,status:{in:['PLANNED','APPROVED','PAUSED']}},orderBy:{sequence:'asc'}});
    strictEqual(senderReplacement.length,1);
    strictEqual(senderReplacement[0].scheduledAt.getTime()>=confirmedMix.confirmedAt!.getTime()+6*60*60_000,true,
      'Replacement should use the confirmed 260 Bandwidth spend and reach 400 with a one-hour buffer');
    strictEqual(senderReplacement[0].note,null);
    const openMix=await db.transfer.findMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED','SUBMITTING','SUBMITTED','UNKNOWN']}}});
    strictEqual(new Set(openMix.map(row=>row.from)).size,openMix.length);
    await rejects(tron.prepare(confirmedMix.from,confirmedMix.to,10_000),e=>{
      strictEqual((e as {nextCheckAt?:Date}).nextCheckAt instanceof Date,true);
      return true;
    });
    strictEqual((await db.wallet.findUniqueOrThrow({where:{address:three.address}})).joined,true);
    strictEqual((await db.wallet.findUniqueOrThrow({where:{address:one.address}})).entryBalanceSun,TARGET+7);
    queued=await db.transfer.findMany({where:{kind:'MIX',status:'PLANNED'},orderBy:{sequence:'asc'}});
    strictEqual(queued.length>0,true);
    strictEqual(await db.transfer.count({where:{kind:'MIX',status:'CANCELLED'}})>0,true);
    await db.transfer.update({where:{id:queued[0].id},data:{scheduledAt:new Date(Date.now()-1000)}});
    await resumed.approve(queued[0].id);
    strictEqual((await db.engineState.findUniqueOrThrow({where:{id:1}})).status.startsWith('Waiting between mix transfers'),true);
    strictEqual(await db.transfer.count({where:{kind:'MIX',status:'SUBMITTED'}}),0);
    await resumed.setMixEnabled(two.address,false);
    strictEqual((await db.wallet.findUniqueOrThrow({where:{address:two.address}})).joined,true);
    queued=await db.transfer.findMany({where:{kind:'MIX',status:'PLANNED'}});
    strictEqual(queued.every(t=>t.from!==two.address&&t.to!==two.address),true);
    await resumed.end();
    const settlementCount=await db.transfer.count({where:{kind:{in:['REBALANCE','PAYOUT']}}});
    // Older builds could crash with a committed map while still in
    // END_REQUESTED. A restart must reuse those rows, never insert them again.
    await db.engineState.update({where:{id:1},data:{phase:'END_REQUESTED'}});
    const afterEndRestart=new RestartedEngine(db,tron,config);
    await afterEndRestart.init();
    strictEqual((await db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'SETTLING');
    strictEqual(await db.transfer.count({where:{kind:{in:['REBALANCE','PAYOUT']}}}),settlementCount);
    let phase='SETTLING',worker=afterEndRestart,restartedMidPayout=false;
    for(let i=0;i<20&&phase!=='COMPLETE';i++){
      const pending=await db.transfer.findFirst({where:{status:'PLANNED'},orderBy:{sequence:'asc'}});
      if(pending)await worker.approve(pending.id);
      const submittedPayout=await db.transfer.findFirst({where:{kind:'PAYOUT',status:'SUBMITTED'}});
      if(submittedPayout&&!restartedMidPayout){
        await db.transfer.update({where:{id:submittedPayout.id},data:{status:'SUBMITTING'}});
        worker=new RestartedEngine(db,tron,config);
        await worker.init();
        restartedMidPayout=true;
      }
      await worker.tick();
      // In the mock, advance the completed transfers beyond the rolling
      // bandwidth window; a live settlement can take several real days.
      await db.transfer.updateMany({where:{status:'CONFIRMED'},data:{updatedAt:new Date(Date.now()-90_000_000)}});
      // Also advance the predicted recovery check when simulating the passage
      // of a day. Live scheduledAt is never moved backwards by the worker.
      await db.transfer.updateMany({where:{status:'APPROVED',kind:{in:['REBALANCE','PAYOUT']}},data:{scheduledAt:new Date(Date.now()-1000)}});
      phase=(await db.engineState.findUniqueOrThrow({where:{id:1}})).phase;
    }
    const finalState=await db.engineState.findUniqueOrThrow({where:{id:1}});
    const open=await db.transfer.findMany({where:{status:{in:['PLANNED','APPROVED','SUBMITTED','SUBMITTING','PAUSED','UNKNOWN']}},select:{kind:true,status:true,amountSun:true,from:true}});
    strictEqual(phase,'COMPLETE',JSON.stringify({status:finalState.status,open}));
    strictEqual(restartedMidPayout,true);
    const payouts=await db.transfer.findMany({where:{kind:'PAYOUT',status:'CONFIRMED'}});
    strictEqual(payouts.length,3);
    strictEqual(payouts.every(t=>t.amountSun===TARGET),true);
    deepStrictEqual(await Promise.all([one,two,three].map(async w=>(await db!.wallet.findUniqueOrThrow({where:{address:w.address}})).balanceSnapshotSun)),[7,4,0]);
    strictEqual((await db.wallet.findUniqueOrThrow({where:{address:rest.at(-1)!.address}})).balanceSnapshotSun,0);
  }finally{
    await db?.$disconnect();
    await rm(directory,{recursive:true,force:true});
  }
});
