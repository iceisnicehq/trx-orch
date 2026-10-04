import {test} from 'node:test';
import {deepStrictEqual,match,strictEqual} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {PrismaClient} from '@prisma/client';
import {createDatabase} from './database.js';
import {renderQueue,TelegramService} from './telegram.js';

test('Telegram edits a compact queue, sends audit details, and retries after restart',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'.telegram-test-'));
  process.env.DATABASE_URL=`file:${join(directory,'pool.db')}`;
  let db:PrismaClient|undefined;
  const originalFetch=globalThis.fetch;
  try{
    const migrations=(await readdir('prisma/migrations',{withFileTypes:true})).filter(f=>f.isDirectory()).map(f=>f.name).sort();
    const sql=(await Promise.all(migrations.map(dir=>readFile(`prisma/migrations/${dir}/migration.sql`,'utf8')))).join('\n');
    execFileSync('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',join(directory,'pool.db'),sql]);
    db=createDatabase();
    const first=`T${'A'.repeat(30)}123`,second=`T${'B'.repeat(30)}987`,teacher=`T${'C'.repeat(30)}XYZ`;
    await db.wallet.createMany({data:[{address:first,ordinal:0},{address:second,ordinal:1}]});
    await db.engineState.create({data:{id:1,teacherAddress:teacher,teacherBaseline:0,phase:'MIXING'}});
    const transfer=await db.transfer.create({data:{sequence:25,kind:'MIX',status:'PLANNED',from:first,to:second,
      amountSun:148723,scheduledAt:new Date('2026-09-29T09:30:00.000Z')}});
    await db.audit.create({data:{event:'QUEUED',detail:'Existing before integration was enabled',transferId:transfer.id}});
    const options={botToken:'000000:exampleToken',channelId:'-1001234567890',pinnedMessageId:1234};
    const calls:{method:string;body:Record<string,unknown>}[]=[];
    let failNextSend=false,unchangedEdit=false;
    globalThis.fetch=async(input,init)=>{
      const method=String(input).split('/').at(-1)!;
      const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
      calls.push({method,body});
      if(method==='editMessageText'&&unchangedEdit){unchangedEdit=false;
        return new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message is not modified'}),{status:400});}
      if(method==='sendMessage'&&failNextSend){failNextSend=false;
        return new Response(JSON.stringify({ok:false,error_code:429,description:'Too Many Requests',parameters:{retry_after:1}}),{status:429});}
      return new Response(JSON.stringify({ok:true,result:{message_id:2000+calls.length}}),{status:200});
    };
    const service=new TelegramService(db,options);
    await service.bootstrap();
    strictEqual((await db.telegramCursor.findUniqueOrThrow({where:{channelId:options.channelId}})).lastAuditId,1);
    await service.runOnce();
    strictEqual(calls.length,1);
    strictEqual(calls[0].method,'editMessageText');
    strictEqual(calls[0].body.message_id,1234);
    match(String(calls[0].body.text),/Node 1 \(123\) → Node 2 \(987\)/);
    strictEqual(String(calls[0].body.text).includes(first),false);
    strictEqual(await db.telegramDelivery.count(),0,'No historic flood when Telegram is first enabled');

    await db.transfer.update({where:{id:transfer.id},data:{status:'APPROVED'}});
    const approval=await db.audit.create({data:{event:'APPROVED',detail:'Manual approval',transferId:transfer.id}});
    await service.runOnce();
    strictEqual(calls.at(-2)?.method,'editMessageText');
    strictEqual(calls.at(-1)?.method,'sendMessage');
    match(String(calls.at(-1)!.body.text),/#25 MIX · APPROVED/);
    strictEqual((await db.telegramDelivery.findUniqueOrThrow({where:{channelId_auditId:{channelId:options.channelId,auditId:approval.id}}})).status,'SENT');

    await db.transfer.update({where:{id:transfer.id},data:{status:'CONFIRMED',txId:'a'.repeat(64),
      bandwidthUsed:267,confirmedAt:new Date('2026-09-29T09:45:00.000Z')}});
    const confirmed=await db.audit.create({data:{event:'CONFIRMED',detail:'Confirmed: 267 Bandwidth used',transferId:transfer.id}});
    failNextSend=true;
    await service.runOnce();
    const pending=await db.telegramDelivery.findUniqueOrThrow({where:{channelId_auditId:{channelId:options.channelId,auditId:confirmed.id}}});
    strictEqual(pending.status,'PENDING');
    strictEqual(pending.attempts,1);
    match(pending.text,/Bandwidth used: 267/);
    match(pending.text,/Time: 29\/09\/26, 12:45 MSK/);
    strictEqual(String(calls.at(-2)!.body.text).includes('0 open'),true);

    // A restarted worker retains the cursor and pending delivery, then
    // refreshes the pinned post once to recover from an uncertain edit.
    await db.telegramDelivery.update({where:{id:pending.id},data:{nextAttemptAt:new Date(Date.now()-1000)}});
    const restarted=new TelegramService(db,options);
    await restarted.bootstrap();
    unchangedEdit=true;
    const before=calls.length;
    await restarted.runOnce();
    strictEqual(calls.length,before+2);
    strictEqual(calls.at(-2)?.method,'editMessageText');
    strictEqual(calls.at(-1)?.method,'sendMessage');
    strictEqual((await db.telegramDelivery.findUniqueOrThrow({where:{id:pending.id}})).status,'SENT');
    strictEqual((await db.telegramCursor.findUniqueOrThrow({where:{channelId:options.channelId}})).lastQueueHash!==null,true);
    strictEqual(await db.telegramDelivery.count(),2);

    const routine=await db.audit.create({data:{event:'PLAN',detail:'Routine scheduling event'}});
    const fatal=await db.audit.create({data:{event:'FATAL',detail:`Wallet ${first} needs investigation`}});
    await restarted.runOnce();
    strictEqual((await db.telegramDelivery.findUniqueOrThrow({where:{channelId_auditId:{channelId:options.channelId,auditId:fatal.id}}})).status,'SENT');
    strictEqual((await db.telegramDelivery.findUniqueOrThrow({where:{channelId_auditId:{channelId:options.channelId,auditId:routine.id}}})).status,'PENDING');
    match(String(calls.at(-1)!.body.text),/Node 1 \(123\) needs investigation/);
    await restarted.runOnce();
    strictEqual((await db.telegramDelivery.findUniqueOrThrow({where:{channelId_auditId:{channelId:options.channelId,auditId:routine.id}}})).status,'SENT');
  }finally{
    globalThis.fetch=originalFetch;
    await db?.$disconnect();
    await rm(directory,{recursive:true,force:true});
  }
});

test('large queue truncates cleanly and shows only the last three address characters',()=>{
  const first=`T${'A'.repeat(30)}123`,second=`T${'B'.repeat(30)}987`;
  const rows=Array.from({length:100},(_,i)=>({sequence:i+1,kind:'PAYOUT',from:first,to:second,
    amountSun:1_000_000,scheduledAt:new Date('2026-09-29T09:30:00.000Z'),status:'APPROVED'}));
  const text=renderQueue('SETTLING',rows,[{address:first,ordinal:0},{address:second,ordinal:1}],second);
  strictEqual(text.length<=4096,true);
  strictEqual(text.includes(first),false);
  match(text,/\.\.\. \d+ more in the dashboard/);
  deepStrictEqual(text.split('\n')[0],'TRX QUEUE · SETTLING');
});
