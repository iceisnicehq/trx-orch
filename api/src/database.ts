import {AsyncLocalStorage} from 'node:async_hooks';
import {Prisma,PrismaClient} from '@prisma/client';

const WRITES=new Set(['create','createMany','createManyAndReturn','update','updateMany','updateManyAndReturn','upsert','delete','deleteMany']);

/** One process, one SQLite writer. Queue outside the native busy handler so
 * concurrent BEGIN IMMEDIATE calls cannot starve the lock holder's COMMIT.
 * Reads remain concurrent. Transaction-scoped queries already hold this gate.
 * Never retry a transaction body: signing and receipts must remain explicit. */
export function createDatabase(options:Prisma.PrismaClientOptions={}){
  const context=new AsyncLocalStorage<boolean>();
  let tail:Promise<void>=Promise.resolve();
  function serial<T>(action:()=>Promise<T>):Promise<T>{
    const result=tail.then(()=>context.run(true,action));
    tail=result.then(()=>{},()=>{}); // a rejected transaction must not poison the queue
    return result;
  }
  const base=new PrismaClient({...options,transactionOptions:{maxWait:10_000,timeout:30_000,...options.transactionOptions}});
  const client=base.$extends({name:'sqlite-writer-queue',query:{
    $allOperations({operation,args,query}){
      const write=WRITES.has(operation)||operation.startsWith('$executeRaw')||operation.startsWith('$queryRaw');
      return write&&!context.getStore()?serial(()=>query(args)):query(args);
    }
  }});
  const transaction=client.$transaction.bind(client);
  return new Proxy(client,{
    get(target,key,receiver){
      if(key==='$transaction')return (...args:unknown[])=>{
        if(context.getStore())throw Error('Nested transactions are not supported; use the supplied transaction client');
        return serial(()=>Reflect.apply(transaction,target,args));
      };
      return Reflect.get(target,key,receiver);
    }
  }) as unknown as PrismaClient;
}
