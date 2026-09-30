import {test} from 'node:test';
import {deepStrictEqual,strictEqual,rejects} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {PrismaClient} from '@prisma/client';

async function pool(){
  const directory=await mkdtemp(join(process.cwd(),'.extra-reserve-test-'));
  process.env.TRON_MODE='mock';
  process.env.DATABASE_URL=`file:${join(directory,'pool.db')}`;
  const migrations=['20260926000000_init','20260928000000_dynamic_members',
    '20260929000000_bandwidth_receipts','20260929010000_bandwidth_block_time',
    '20260929020000_telegram_notifications','20260929030000_rebalance_and_amount_modes',
    '20260930000000_external_extra_reserves'];
  const sql=(await Promise.all(migrations.map(dir=>readFile(`prisma/migrations/${dir}/migration.sql`,'utf8')))).join('\n');
  execFileSync('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',join(directory,'pool.db'),sql]);
  const [{loadConfig,TARGET},{TronService},{EngineService}]=await Promise.all([
    import('./config.js'),import('./tron.js'),import('./engine.js')
  ]);
  const config=await loadConfig(),db=new PrismaClient();
  const tron=new TronService(db,config),engine=new EngineService(db,tron,config);
  await engine.init();
  const members=config.wallets.slice(0,2);
  for(const w of members){
    await db.wallet.update({where:{address:w.address},data:{balanceSnapshotSun:TARGET+1}});
    await engine.setMixEnabled(w.address,true);
  }
  await engine.start();
  return {db,tron,engine,config,members,TARGET,directory};
}

test('a one-Sun incoming surplus during a confirmed MIX becomes personal reserve and never enters payouts',async()=>{
  const p=await pool();
  try{
    await p.engine.setMixAmounts('LIST',[p.TARGET]);
    const mix=await p.db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'PLANNED'}});
    await p.engine.approve(mix.id);
    strictEqual((await p.db.transfer.findUniqueOrThrow({where:{id:mix.id}})).status,'SUBMITTED');
    await p.db.wallet.update({where:{address:mix.to},data:{balanceSnapshotSun:{increment:1}}});
    await p.engine.tick();
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'MIXING');
    strictEqual((await p.db.transfer.findUniqueOrThrow({where:{id:mix.id}})).status,'CONFIRMED');
    strictEqual((await p.db.wallet.findUniqueOrThrow({where:{address:mix.to}})).entryBalanceSun,p.TARGET+2);
    strictEqual(await p.db.audit.count({where:{event:'EXTRA_RESERVE'}}),1);
    await p.engine.tick();
    strictEqual(await p.db.audit.count({where:{event:'EXTRA_RESERVE'}}),1,'The same Sun must never be counted twice');
    p.tron.bandwidthSnapshot=async()=>({available:600,limit:600,observedAt:Date.now()});
    await p.engine.end();
    for(let i=0;i<15;i++){
      if((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase==='COMPLETE')break;
      const next=await p.db.transfer.findFirst({where:{status:'PLANNED',kind:{in:['REBALANCE','PAYOUT']}},orderBy:{sequence:'asc'}});
      if(next)await p.engine.approve(next.id);
      await p.engine.tick();
    }
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'COMPLETE');
    strictEqual(await p.tron.teacherBalance(),2*p.TARGET);
    strictEqual((await p.db.wallet.findUniqueOrThrow({where:{address:mix.to}})).balanceSnapshotSun,2);
    strictEqual((await p.db.wallet.findUniqueOrThrow({where:{address:mix.from}})).balanceSnapshotSun,1);
  }finally{await p.db.$disconnect();await rm(p.directory,{recursive:true,force:true});}
});

test('a pre-upgrade HALTED pool recovers only after a password-gated, positive-only ledger review',async()=>{
  const p=await pool();
  try{
    await p.db.wallet.update({where:{address:p.members[1].address},data:{balanceSnapshotSun:{increment:1}}});
    // The old image persisted HALTED without recording the previous phase.
    await p.db.engineState.update({where:{id:1},data:{phase:'HALTED',haltedFromPhase:null,
      fatalReason:'Pool invariant violated: 2000003 Sun, expected 2000002',
      status:'FATAL: Pool invariant violated: 2000003 Sun, expected 2000002'}});
    const {EngineService}=await import('./engine.js');
    const afterRestart=new EngineService(p.db,p.tron,p.config);
    await afterRestart.init();
    const preview=await afterRestart.extraRecoveryPreview();
    strictEqual(preview.eligible,true);
    strictEqual(preview.phase,'MIXING');
    deepStrictEqual(preview.extras,[{address:p.members[1].address,sun:1}]);
    await afterRestart.resumeExtraReserves();
    const s=await p.db.engineState.findUniqueOrThrow({where:{id:1}});
    strictEqual(s.phase,'MIXING');strictEqual(s.fatalReason,null);
    strictEqual(s.haltedFromPhase,null);
    strictEqual((await p.db.wallet.findUniqueOrThrow({where:{address:p.members[1].address}})).entryBalanceSun,p.TARGET+2);
    strictEqual(await p.db.audit.count({where:{event:'RESUMED'}}),1);
    strictEqual(await p.db.transfer.count({where:{kind:'MIX',status:'CANCELLED'}}),0,'Existing plans and approvals survive recovery');
    await rejects(afterRestart.resumeExtraReserves(),/Recovery is available only for a halted game/);
  }finally{await p.db.$disconnect();await rm(p.directory,{recursive:true,force:true});}
});

test('positive deposits cannot conceal a one-Sun deficit or bypass a different fatal reason',async()=>{
  const p=await pool();
  try{
    await p.db.wallet.update({where:{address:p.members[0].address},data:{balanceSnapshotSun:{decrement:1}}});
    await p.db.wallet.update({where:{address:p.members[1].address},data:{balanceSnapshotSun:{increment:2}}});
    await p.engine.tick();
    let s=await p.db.engineState.findUniqueOrThrow({where:{id:1}});
    strictEqual(s.phase,'HALTED');
    strictEqual(s.haltedFromPhase,'MIXING');
    strictEqual((await p.engine.extraRecoveryPreview()).eligible,false);
    await rejects(p.engine.resumeExtraReserves(),/cannot be recovered automatically/);
    await p.db.engineState.update({where:{id:1},data:{fatalReason:'Receipt unresolved for a saved transaction'}});
    strictEqual((await p.engine.extraRecoveryPreview()).eligible,false);
    s=await p.db.engineState.findUniqueOrThrow({where:{id:1}});
    strictEqual(s.phase,'HALTED');
  }finally{await p.db.$disconnect();await rm(p.directory,{recursive:true,force:true});}
});

test('a late extra Sun does not invalidate a previously saved End payout map',async()=>{
  const p=await pool();
  try{
    p.tron.bandwidthSnapshot=async()=>({available:600,limit:600,observedAt:Date.now()});
    await p.engine.end();
    const payouts=await p.db.transfer.findMany({where:{kind:'PAYOUT',status:'PLANNED'}});
    strictEqual(payouts.length,2);
    await p.db.wallet.update({where:{address:p.members[1].address},data:{balanceSnapshotSun:{increment:1}}});
    await p.engine.tick();
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'SETTLING');
    for(let i=0;i<8;i++){
      if((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase==='COMPLETE')break;
      const next=await p.db.transfer.findFirst({where:{kind:'PAYOUT',status:'PLANNED'},orderBy:{sequence:'asc'}});
      if(next)await p.engine.approve(next.id);
      await p.engine.tick();
    }
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'COMPLETE');
    strictEqual(await p.tron.teacherBalance(),2*p.TARGET);
    strictEqual((await p.db.wallet.findUniqueOrThrow({where:{address:p.members[1].address}})).balanceSnapshotSun,2);
    strictEqual(await p.db.transfer.count({where:{kind:'PAYOUT'}}),2,'Do not rebuild a saved payout map');
  }finally{await p.db.$disconnect();await rm(p.directory,{recursive:true,force:true});}
});

test('extra Sun arriving after a saved Rebalance map stays on its wallet and mixing resumes',async()=>{
  const p=await pool();
  try{
    p.tron.bandwidthSnapshot=async()=>({available:600,limit:600,observedAt:Date.now()});
    await p.engine.setMixAmounts('LIST',[p.TARGET]);
    const mix=await p.db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'PLANNED'}});
    await p.engine.approve(mix.id);
    await p.engine.tick();
    await p.engine.rebalance();
    const step=await p.db.transfer.findFirstOrThrow({where:{kind:'REBALANCE',status:'PLANNED'}});
    const receiver=p.members[0].address;
    await p.db.wallet.update({where:{address:receiver},data:{balanceSnapshotSun:{increment:1}}});
    await p.engine.tick();
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'REBALANCING');
    await p.engine.approve(step.id);
    await p.engine.tick();
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'MIXING');
    const wallet=await p.db.wallet.findUniqueOrThrow({where:{address:receiver}});
    strictEqual(wallet.balanceSnapshotSun,wallet.entryBalanceSun);
    strictEqual(wallet.entryBalanceSun,p.TARGET+2);
    strictEqual(await p.db.transfer.count({where:{kind:'REBALANCE'}}),1,'Keep the saved balancing route');
  }finally{await p.db.$disconnect();await rm(p.directory,{recursive:true,force:true});}
});

test('teacher balance changes or RPC failure cannot halt mixing or exact payouts',async()=>{
  const p=await pool();
  try{
    let teacherBalanceCalls=0;
    p.tron.teacherBalance=async()=>{teacherBalanceCalls++;throw Error('Teacher balance is independently controlled');};
    await p.engine.tick();
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'MIXING');
    p.tron.bandwidthSnapshot=async()=>({available:600,limit:600,observedAt:Date.now()});
    await p.engine.end();
    for(let i=0;i<8;i++){
      if((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase==='COMPLETE')break;
      const next=await p.db.transfer.findFirst({where:{kind:'PAYOUT',status:'PLANNED'},orderBy:{sequence:'asc'}});
      if(next)await p.engine.approve(next.id);
      await p.engine.tick();
    }
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'COMPLETE');
    strictEqual(await p.db.transfer.count({where:{kind:'PAYOUT',status:'CONFIRMED',amountSun:p.TARGET}}),2);
    strictEqual(teacherBalanceCalls,0,'Do not use the teacher balance as a payout preflight');
  }finally{await p.db.$disconnect();await rm(p.directory,{recursive:true,force:true});}
});

test('an existing teacher-balance HALT resumes after checking participant ledger, preserving the queue',async()=>{
  const p=await pool();
  try{
    const planned=await p.db.transfer.findFirstOrThrow({where:{kind:'MIX',status:'PLANNED'}});
    await p.db.engineState.update({where:{id:1},data:{phase:'HALTED',haltedFromPhase:'MIXING',
      fatalReason:'Teacher balance differs from attributed payouts',status:'FATAL: Teacher balance differs from attributed payouts'}});
    p.tron.teacherBalance=async()=>{throw Error('Teacher balance must not be queried during recovery');};
    const {EngineService}=await import('./engine.js');
    const afterRestart=new EngineService(p.db,p.tron,p.config);
    await afterRestart.init();
    const preview=await afterRestart.extraRecoveryPreview();
    strictEqual(preview.eligible,true);strictEqual(preview.phase,'MIXING');
    strictEqual(preview.haltReason,'Teacher balance differs from attributed payouts');
    deepStrictEqual(preview.extras,[]);
    await afterRestart.resumeExtraReserves();
    const s=await p.db.engineState.findUniqueOrThrow({where:{id:1}});
    strictEqual(s.phase,'MIXING');strictEqual(s.fatalReason,null);
    strictEqual((await p.db.transfer.findUniqueOrThrow({where:{id:planned.id}})).status,'PLANNED');
    strictEqual(await p.db.audit.count({where:{event:'RESUMED'}}),1);
  }finally{await p.db.$disconnect();await rm(p.directory,{recursive:true,force:true});}
});

test('teacher-balance recovery does not override a participant deficit or rebuild saved payouts',async()=>{
  const p=await pool();
  try{
    p.tron.bandwidthSnapshot=async()=>({available:600,limit:600,observedAt:Date.now()});
    await p.engine.end();
    const payouts=await p.db.transfer.findMany({where:{kind:'PAYOUT',status:'PLANNED'}});
    strictEqual(payouts.length,2);
    await p.db.engineState.update({where:{id:1},data:{phase:'HALTED',haltedFromPhase:'SETTLING',
      fatalReason:'Teacher balance differs from attributed payouts'}});
    await p.db.wallet.update({where:{address:p.members[0].address},data:{balanceSnapshotSun:{decrement:1}}});
    strictEqual((await p.engine.extraRecoveryPreview()).eligible,false);
    await rejects(p.engine.resumeExtraReserves(),/below its audited balance|Pool invariant violated/);
    await p.db.wallet.update({where:{address:p.members[0].address},data:{balanceSnapshotSun:{increment:1}}});
    strictEqual((await p.engine.extraRecoveryPreview()).eligible,true);
    await p.engine.resumeExtraReserves();
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'SETTLING');
    strictEqual(await p.db.transfer.count({where:{kind:'PAYOUT'}}),2,'Reuse the saved End map');
    for(let i=0;i<8;i++){
      if((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase==='COMPLETE')break;
      const next=await p.db.transfer.findFirst({where:{kind:'PAYOUT',status:'PLANNED'},orderBy:{sequence:'asc'}});
      if(next)await p.engine.approve(next.id);
      await p.engine.tick();
    }
    strictEqual((await p.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'COMPLETE');
    strictEqual(await p.db.transfer.count({where:{kind:'PAYOUT',status:'CONFIRMED',amountSun:p.TARGET}}),2);
  }finally{await p.db.$disconnect();await rm(p.directory,{recursive:true,force:true});}
});
