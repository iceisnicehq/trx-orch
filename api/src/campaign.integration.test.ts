import {test} from 'node:test';
import {strictEqual,ok,rejects,deepStrictEqual,match} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {PrismaClient} from '@prisma/client';

process.env.TRON_MODE='mock';

async function fixture(count:number){
  const directory=await mkdtemp(join(process.cwd(),'.campaign-test-'));
  const files=(await readdir('prisma/migrations',{withFileTypes:true})).filter(f=>f.isDirectory()).map(f=>f.name).sort();
  const sql=(await Promise.all(files.map(dir=>readFile(`prisma/migrations/${dir}/migration.sql`,'utf8')))).join('\n');
  execFileSync('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',join(directory,'pool.db'),sql]);
  process.env.DATABASE_URL=`file:${join(directory,'pool.db')}`;
  const [{loadConfig},{TronService},{EngineService}]=await Promise.all([import('./config.js'),import('./tron.js'),import('./engine.js')]);
  const config=await loadConfig(),db=new PrismaClient(),members=config.wallets.slice(0,count);
  let tron=new TronService(db,config),engine=new EngineService(db,tron,config,true);
  await engine.init();engine.stop();
  for(let i=0;i<count;i++){
    await db.wallet.update({where:{address:members[i].address},data:{balanceSnapshotSun:1_000_000+i+1}});
    await engine.setMixEnabled(members[i].address,true);
  }
  const clock={at:Date.now()},originalNow=Date.now;
  Date.now=()=>clock.at;
  const stub=(t:InstanceType<typeof TronService>)=>{
    t.bandwidthSnapshot=async()=>({available:600,limit:600,observedAt:clock.at});
    t.recentBandwidthSpends=async()=>[];
    t.receipt=async()=>({found:true,success:true,feeSun:0,bandwidthUsed:267,confirmedAt:new Date(clock.at)});
  };
  stub(tron);
  return {db,members,config,clock,get engine(){return engine;},get tron(){return tron;},
    async restart(){
      engine.stop();const fresh=await loadConfig();tron=new TronService(db,fresh);stub(tron);
      engine=new EngineService(db,tron,fresh,true);await engine.init();engine.stop();
    },
    async close(){engine.stop();Date.now=originalNow;await db.$disconnect();await rm(directory,{recursive:true,force:true});}
  };
}

async function drain(f:Awaited<ReturnType<typeof fixture>>,target:string){
  for(let i=0;i<1800;i++){
    const s=await f.db.engineState.findUniqueOrThrow({where:{id:1}});
    if(s.phase===target)return;
    if(s.phase==='HALTED')throw Error(s.status);
    const flight=await f.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED']}}});
    if(!flight){
      const kind=s.phase==='CAMPAIGN'?'MIX':s.phase==='SETTLING'?'PAYOUT':'RETURN';
      const next=await f.db.transfer.findFirst({where:{kind,status:{in:['PLANNED','APPROVED']}},orderBy:kind==='MIX'?{sequence:'asc'}:[{scheduledAt:'asc'},{sequence:'asc'}]});
      if(next){f.clock.at=Math.max(f.clock.at,next.scheduledAt.getTime()+1000);if(next.status==='PLANNED')await f.engine.approve(next.id);}
    }
    await f.engine.tick();
  }
  throw Error('Campaign did not drain');
}

test('complete four-wallet campaign restores original ownership, CSV and a changed teacher survive restarts',async()=>{
  const f=await fixture(4);
  try{
    const {ownerReport,reportCsv}=await import('./campaign-report.js');
    const {verifyOwnership}=await import('./ownership.js');
    await f.engine.startCampaign();
    const original=await f.db.transfer.findMany({where:{campaignId:{not:null}},orderBy:{sequence:'asc'}});
    ok(original.length>112);
    strictEqual(original.every(t=>t.status==='PLANNED'),true);
    strictEqual(await f.db.transfer.count({where:{txId:{not:null}}}),0);
    const s=await f.db.engineState.findUniqueOrThrow({where:{id:1}});
    const report=await ownerReport(f.db,f.members[0].address);
    ok(report&&report.events.some(e=>e.from!==report.address&&e.to!==report.address),'Report follows the stake through other wallets');
    const csv=reportCsv(report!);
    match(csv,/scheduled_msk/);ok(csv.includes(f.members[0].address));ok(csv.startsWith('\uFEFF'));
    ok(!JSON.stringify(report).includes('signedJson'));ok(!JSON.stringify(report).includes('privateKey'));
    await rejects(f.engine.setMixEnabled(f.members[0].address,false),/participants are fixed/);
    // Manual approval is durable and does not send early.
    await f.engine.approve(original[0].id);
    strictEqual((await f.db.transfer.findUniqueOrThrow({where:{id:original[0].id}})).status,'APPROVED');
    await f.engine.autoApprove(original[0].from,true);
    await f.engine.autoApprove(original[0].from,false);
    strictEqual((await f.db.transfer.findUniqueOrThrow({where:{id:original[0].id}})).approvalSource,'MANUAL');
    strictEqual(await f.db.transfer.count({where:{from:original[0].from,approvalSource:'AUTO',status:'APPROVED'}}),0);
    f.clock.at=original[0].scheduledAt.getTime()+1000;
    await f.engine.tick();
    const signed=await f.db.transfer.findUniqueOrThrow({where:{id:original[0].id}});
    strictEqual(signed.status,'SUBMITTED');
    await rejects(f.engine.changeTeacher(f.config.wallets[16].address),/participant/);
    await rejects(f.engine.changeTeacher(f.config.teacherAddress==='x'?'x':'bad-address'),/Base58Check/);
    await f.db.transfer.update({where:{id:signed.id},data:{status:'SUBMITTING'}});
    await f.restart();
    const confirmed=await f.db.transfer.findUniqueOrThrow({where:{id:signed.id}});
    strictEqual(confirmed.status,'CONFIRMED');strictEqual(confirmed.txId,signed.txId);
    strictEqual(await f.db.transfer.count({where:{campaignId:s.activeCampaignId}}),original.length,'Restart never regenerates the campaign');
    const after=await verifyOwnership(f.db,s.activeCampaignId!);
    ok(after.some(p=>p.ownerAddress!==p.holderAddress));
    await f.restart();
    deepStrictEqual(await verifyOwnership(f.db,s.activeCampaignId!),after,'Receipt application is idempotent');
    // Additional personal dust does not enter ownership or alter the stake.
    await f.db.wallet.update({where:{address:f.members[0].address},data:{balanceSnapshotSun:{increment:3}}});
    await f.engine.tick();
    strictEqual((await f.db.wallet.findUniqueOrThrow({where:{address:f.members[0].address}})).entryBalanceSun,1_000_004);
    for(const w of f.members)await f.engine.autoApprove(w.address,true);
    await drain(f,'CAMPAIGN_RESTORED');
    const final=await verifyOwnership(f.db,s.activeCampaignId!);
    for(const p of final){strictEqual(p.ownerAddress,p.holderAddress);strictEqual(p.amountSun,1_000_000);}
    for(const w of f.members)strictEqual(await f.db.transfer.count({where:{campaignId:s.activeCampaignId,kind:'MIX',from:w.address,status:'CONFIRMED'}}),28);
    const {TronWeb}=await import('tronweb');
    const newTeacher=TronWeb.address.fromPrivateKey('1'.repeat(64));ok(newTeacher);
    await f.engine.changeTeacher(newTeacher as string);
    await f.restart();
    strictEqual((await f.db.engineState.findUniqueOrThrow({where:{id:1}})).teacherAddress,newTeacher);
    await f.engine.end();
    const payoutCount=await f.db.transfer.count({where:{kind:'PAYOUT'}});
    await f.engine.end();
    strictEqual(await f.db.transfer.count({where:{kind:'PAYOUT'}}),payoutCount,'Repeated End Game must not duplicate payout rows');
    await rejects(f.engine.changeTeacher(f.config.teacherAddress),/payout batch/);
    await drain(f,'COMPLETE');
    const payouts=await f.db.transfer.findMany({where:{kind:'PAYOUT',status:'CONFIRMED'}});
    strictEqual(payouts.length,4);ok(payouts.every(t=>t.to===newTeacher&&t.amountSun===1_000_000));
    const paidReport=await ownerReport(f.db,f.members[0].address);
    const lastPayout=paidReport!.events.find(t=>t.kind==='PAYOUT')!;
    strictEqual(lastPayout.toComposition.find(p=>p.ownerAddress===f.members[0].address)!.amountSun,1_000_000,'Report retains the original stake receipt at the teacher');
    deepStrictEqual(await Promise.all(f.members.map(async w=>(await f.db.wallet.findUniqueOrThrow({where:{address:w.address}})).balanceSnapshotSun)),[4,2,3,4]);
    strictEqual((await verifyOwnership(f.db,s.activeCampaignId!)).length,0);
  }finally{await f.close();}
});

test('early return waits for an accepted transaction and recovers its closing map after shutdown',async()=>{
  const f=await fixture(4);
  try{
    await f.engine.startCampaign();
    const first=await f.db.transfer.findFirstOrThrow({where:{kind:'MIX'},orderBy:{sequence:'asc'}});
    f.clock.at=first.scheduledAt.getTime()+1000;await f.engine.approve(first.id);
    const signed=await f.db.transfer.findUniqueOrThrow({where:{id:first.id}});
    strictEqual(signed.status,'SUBMITTED');
    // Prisma uses real wall time; align this simulated recovery window with
    // the test's clock, which has advanced to the planned send time.
    await f.db.transfer.update({where:{id:first.id},data:{updatedAt:new Date(f.clock.at)}});
    f.tron.receipt=async()=>({found:false,success:false,feeSun:0,bandwidthUsed:null,confirmedAt:null});
    await f.engine.returnCampaign();
    strictEqual((await f.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'CAMPAIGN_RETURN_REQUESTED');
    strictEqual(await f.db.transfer.count({where:{kind:'MIX',status:{in:['PLANNED','APPROVED']}}}),0);
    await f.db.transfer.update({where:{id:first.id},data:{status:'SUBMITTING'}});
    await f.restart();
    strictEqual((await f.db.transfer.findUniqueOrThrow({where:{id:first.id}})).txId,signed.txId);
    strictEqual((await f.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'CAMPAIGN_RETURNING');
    const map=await f.db.transfer.findMany({where:{kind:'RETURN',status:{not:'CANCELLED'}}});ok(map.length>0);
    await f.db.transfer.update({where:{id:map[0].id},data:{scheduledAt:new Date(f.clock.at+60_000)}});
    await f.engine.approve(map[0].id);
    await f.engine.returnCampaign();
    await f.engine.rebalance();
    deepStrictEqual((await f.db.transfer.findMany({where:{kind:'RETURN',status:{not:'CANCELLED'}}})).map(t=>t.id),map.map(t=>t.id),'Repeated return requests retain the saved map');
    strictEqual((await f.db.transfer.findUniqueOrThrow({where:{id:map[0].id}})).status,'APPROVED','Return retries retain manual approval');
    await f.restart();strictEqual(await f.db.transfer.count({where:{kind:'RETURN',status:{not:'CANCELLED'}}}),map.length);
    await drain(f,'CAMPAIGN_RESTORED');
    strictEqual(await f.db.transfer.count({where:{kind:'PAYOUT'}}),0);
    deepStrictEqual(await Promise.all(f.members.map(async w=>(await f.db.wallet.findUniqueOrThrow({where:{address:w.address}})).balanceSnapshotSun)),[1_000_001,1_000_002,1_000_003,1_000_004]);
  }finally{await f.close();}
});

test('campaign Rebalance and deadline protection pause without creating teacher payouts',async()=>{
  for(const mode of ['rebalance','deadline']){
    const f=await fixture(3);
    try{
      await f.engine.startCampaign();
      const first=await f.db.transfer.findFirstOrThrow({where:{kind:'MIX'},orderBy:{sequence:'asc'}});
      f.clock.at=first.scheduledAt.getTime()+1000;await f.engine.approve(first.id);await f.engine.tick();
      if(mode==='rebalance')await f.engine.rebalance();
      else{
        // The deadline guard may request only attribution restoration.
        await f.db.campaign.updateMany({data:{deadlineAt:new Date(f.clock.at+3*86_400_000)}});
        await f.engine.tick();
      }
      await drain(f,'CAMPAIGN_RESTORED');
      strictEqual(await f.db.transfer.count({where:{kind:'PAYOUT'}}),0);
      strictEqual((await f.db.campaign.findFirstOrThrow()).payAfterReturn,false);
      await f.restart();await f.engine.tick();
      strictEqual((await f.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'CAMPAIGN_RESTORED');
    }finally{await f.close();}
  }
});

test('End Game requested during a flight retains one closing map and exactly one payout per member',async()=>{
  const f=await fixture(3);
  try{
    await f.engine.startCampaign();
    const first=await f.db.transfer.findFirstOrThrow({where:{kind:'MIX'},orderBy:{sequence:'asc'}});
    f.clock.at=first.scheduledAt.getTime()+1000;await f.engine.approve(first.id);
    await f.engine.end();
    strictEqual(await f.db.transfer.count({where:{kind:'PAYOUT'}}),3);
    await f.engine.end();strictEqual(await f.db.transfer.count({where:{kind:'PAYOUT'}}),3);
    await rejects(f.engine.returnCampaign(),/End Game was already explicitly requested/);
    await f.restart();strictEqual(await f.db.transfer.count({where:{kind:'PAYOUT'}}),3);
    await drain(f,'COMPLETE');
    strictEqual(await f.db.transfer.count({where:{kind:'PAYOUT',status:'CONFIRMED'}}),3);
  }finally{await f.close();}
});

test('tampered attribution halts before building or broadcasting a native transfer',async()=>{
  const f=await fixture(3);
  try{
    await f.engine.startCampaign();
    await f.db.ownershipBalance.updateMany({where:{ownerAddress:f.members[0].address},data:{amountSun:{increment:1}}});
    await f.engine.tick();
    strictEqual((await f.db.engineState.findUniqueOrThrow({where:{id:1}})).phase,'HALTED');
    strictEqual(await f.db.transfer.count({where:{txId:{not:null}}}),0);
  }finally{await f.close();}
});
