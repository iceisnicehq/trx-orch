import {test} from 'node:test';
import {deepStrictEqual,strictEqual} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {PrismaClient} from '@prisma/client';
import {nodeHistory} from './node-history.js';

test('node transfer history pages through every record without losing rows when new transfers arrive',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'.history-test-'));
  process.env.DATABASE_URL=`file:${join(directory,'pool.db')}`;
  let db:PrismaClient|undefined;
  try{
    const migrations=['20260926000000_init','20260928000000_dynamic_members',
      '20260929000000_bandwidth_receipts','20260929010000_bandwidth_block_time',
      '20260929020000_telegram_notifications','20260929030000_rebalance_and_amount_modes'];
    const sql=(await Promise.all(migrations.map(dir=>readFile(`prisma/migrations/${dir}/migration.sql`,'utf8')))).join('\n');
    execFileSync('python3',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',join(directory,'pool.db'),sql]);
    db=new PrismaClient();
    const a='sender',b='recipient',other='other';
    await db.wallet.createMany({data:[{address:a,ordinal:0},{address:b,ordinal:1},{address:other,ordinal:2}]});
    await db.transfer.createMany({data:Array.from({length:112},(_,i)=>({sequence:i+1,kind:'MIX',
      status:i%7===0?'CANCELLED':'CONFIRMED',from:i%2?a:b,to:i%2?b:a,amountSun:10_000,scheduledAt:new Date()}))});
    const first=await nodeHistory(db,a);
    strictEqual(first.total,112);strictEqual(first.items.length,50);strictEqual(first.nextBefore,63);
    await db.transfer.create({data:{sequence:113,kind:'MIX',status:'PLANNED',from:a,to:other,amountSun:500_000,scheduledAt:new Date()}});
    const second=await nodeHistory(db,a,first.nextBefore!);
    const third=await nodeHistory(db,a,second.nextBefore!);
    strictEqual(second.items.length,50);strictEqual(third.items.length,12);strictEqual(third.nextBefore,null);
    deepStrictEqual([...first.items,...second.items,...third.items].map(t=>t.sequence),
      Array.from({length:112},(_,i)=>112-i));
    const refreshed=await nodeHistory(db,a);
    strictEqual(refreshed.total,113);strictEqual(refreshed.items[0].sequence,113);
    const recipient=await nodeHistory(db,b);
    strictEqual(recipient.total,112,'Only transfers touching the chosen node appear');
    strictEqual(Object.hasOwn(refreshed.items[0],'signedJson'),false,'Never expose signed payloads');
  }finally{
    await db?.$disconnect();
    await rm(directory,{recursive:true,force:true});
  }
});
