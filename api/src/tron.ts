import {TronWeb} from 'tronweb';
import type {PrismaClient,Wallet} from '@prisma/client';
import {MODE, type Config} from './config.js';
import {bufferedReadyAt,MIN_FREE_BANDWIDTH,RECOVERY_WINDOW_MS,type ForecastSpend} from './recovery.js';

export type Receipt = {found:boolean; success:boolean; feeSun:number; bandwidthUsed:number|null; confirmedAt:Date|null};
export class BandwidthWait extends Error {constructor(message:string,public nextCheckAt:Date){super(message);}}
export type BandwidthSnapshot={available:number;limit:number;observedAt:number};
export class TronService {
  private tron:TronWeb;
  private keys=new Map<string,string>();
  private publicSnapshot?:{expires:number;value:Promise<{address:string;balanceSun:number;bandwidth:number}[]>};
  private nextRpcStart=0;
  constructor(private db:PrismaClient, private config:Config){
    const host=process.env.TRON_FULL_HOST ?? 'https://api.trongrid.io';
    this.tron=new TronWeb({fullHost:host,headers:process.env.TRON_PRO_API_KEY?{'TRON-PRO-API-KEY':process.env.TRON_PRO_API_KEY}:undefined});
    for(const w of config.wallets)this.keys.set(w.address,w.privateKey);
  }
  private async rpc<T>(operation:()=>Promise<T>):Promise<T>{
    if(MODE==='mock')return operation();
    // Pace requests shared by the worker and public dashboard to avoid a 17-wallet burst.
    const now=Date.now(),start=Math.max(now,this.nextRpcStart);
    this.nextRpcStart=start+150;
    if(start>now)await new Promise(resolve=>setTimeout(resolve,start-now));
    return operation();
  }
  invalidatePublicSnapshot(){this.publicSnapshot=undefined;}
  async publicWallets(wallets:Wallet[]){
    if(MODE==='mock')return Promise.all(wallets.map(async w=>({address:w.address,balanceSun:await this.balance(w.address),bandwidth:await this.availableBandwidth(w.address)})));
    if(this.publicSnapshot&&this.publicSnapshot.expires>Date.now())return this.publicSnapshot.value;
    const value=Promise.all(wallets.map(async w=>{
      const balanceSun=await this.balance(w.address);
      // An unfunded, unjoined slot may not be activated yet. No bandwidth is
      // needed from it until the admin selects a funded account.
      const bandwidth=balanceSun===0&&!w.joined?0:await this.availableBandwidth(w.address);
      return {address:w.address,balanceSun,bandwidth};
    }));
    this.publicSnapshot={expires:Date.now()+120_000,value};
    try{return await value;}catch(e){if(this.publicSnapshot?.value===value)this.publicSnapshot.expires=Date.now()+30_000;throw e;}
  }
  async balance(address:string):Promise<number>{
    if(MODE==='mock')return (await this.db.wallet.findUniqueOrThrow({where:{address}})).balanceSnapshotSun;
    const value=await this.rpc(()=>this.tron.trx.getBalance(address));
    if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid on-chain balance');
    return value;
  }
  async teacherBalance():Promise<number>{
    if(MODE==='mock')return Number((await this.db.audit.findMany({where:{event:'MOCK_PAYOUT'},select:{detail:true}})).reduce((n,a)=>n+Number(a.detail),0));
    return this.rpc(()=>this.tron.trx.getBalance(this.config.teacherAddress));
  }
  async active(address:string):Promise<boolean>{
    if(MODE==='mock')return true;
    const account=await this.rpc(()=>this.tron.trx.getAccount(address));
    return Boolean(account?.address);
  }
  async bandwidthSnapshot(address:string):Promise<BandwidthSnapshot>{
    if(MODE==='mock'){
      const windowMs=86_400_000,now=Date.now();
      const since=new Date(now-windowMs);
      const tx=await this.db.transfer.findMany({where:{from:address,status:'CONFIRMED',updatedAt:{gte:since}}});
      // Test-only approximation of recovery; live mode always asks the chain.
      const used=tx.reduce((sum,t)=>sum+Math.ceil((t.bandwidthUsed??260)*Math.max(0,windowMs-(now-t.updatedAt.getTime()))/windowMs),0);
      return {available:Math.max(0,600-used),limit:600,observedAt:now};
    }
    // Mandatory getBandwidth call; also check the free quota independently so no staked
    // bandwidth or burn is assumed to be available for a fee-free transfer.
    const overall=await this.rpc(()=>this.tron.trx.getBandwidth(address));
    const res=await this.rpc(()=>this.tron.trx.getAccountResources(address));
    const free=Number(res.freeNetLimit??0)-Number(res.freeNetUsed??0);
    const limit=Number(res.freeNetLimit??0);
    if(!Number.isFinite(overall)||!Number.isFinite(free)||!Number.isFinite(limit))throw Error('Cannot determine bandwidth');
    return {available:Math.max(0,Math.min(overall,free)),limit,observedAt:Date.now()};
  }
  async availableBandwidth(address:string):Promise<number>{return (await this.bandwidthSnapshot(address)).available;}
  private blockTime(value:number):Date|null{
    return Number.isSafeInteger(value)&&value>1_600_000_000_000&&value<=Date.now()+60_000?new Date(value):null;
  }
  async recentBandwidthSpends(address:string):Promise<ForecastSpend[]>{
    const since=new Date(Date.now()-RECOVERY_WINDOW_MS);
    const rows=await this.db.transfer.findMany({where:{from:address,status:'CONFIRMED',txId:{not:null},
      OR:[{confirmedAt:{gte:since}},{confirmedAt:null,updatedAt:{gte:since}}]},
      orderBy:{sequence:'desc'},take:100,select:{id:true,txId:true,bandwidthUsed:true,confirmedAt:true,updatedAt:true}});
    const spends:ForecastSpend[]=[];
    for(const row of rows){
      let points=row.bandwidthUsed,at=row.confirmedAt;
      if(MODE==='live'&&(!at||points===null)){
        // Older releases kept the txID but did not store the block timestamp.
        // Backfill only recent confirmed transfers; never alter updatedAt,
        // which is also used for audit order and the global mix interval.
        const info=await this.rpc(()=>this.tron.trx.getTransactionInfo(row.txId!)).catch(()=>null);
        if(info?.id===row.txId&&Number(info.fee??0)===0&&Number(info.receipt?.net_fee??0)===0){
          at=this.blockTime(info.blockTimeStamp);
          const usage=info.receipt?.net_usage;
          if(Number.isSafeInteger(usage)&&usage>=0)points=usage;
          if(at||points!==null)await this.db.transfer.update({where:{id:row.id},
            data:{...(at?{confirmedAt:at}:{}),...(points!==null?{bandwidthUsed:points}:{}),updatedAt:row.updatedAt}});
        }
      }
      if(at&&points!==null&&Number.isSafeInteger(points)&&points>0&&at.getTime()<=Date.now()&&at.getTime()+RECOVERY_WINDOW_MS>Date.now())
        spends.push({at:at.getTime(),points});
    }
    return spends;
  }
  private async wait(address:string,snapshot:BandwidthSnapshot,required:number,stage:string){
    if(snapshot.limit<MIN_FREE_BANDWIDTH)throw Error(`Free Bandwidth limit ${snapshot.limit} is below the configured ${MIN_FREE_BANDWIDTH} safety floor`);
    const target=Math.max(MIN_FREE_BANDWIDTH,required);
    if(snapshot.limit<target)throw Error(`Free Bandwidth limit ${snapshot.limit} cannot cover the signed transaction's ${target} point requirement`);
    const spends=await this.recentBandwidthSpends(address);
    const now=Date.now();
    const next=bufferedReadyAt(snapshot.limit,snapshot.available,snapshot.observedAt,now,target,spends);
    const nextCheckAt=new Date(next??now+6*60*60_000);
    const recent=spends.filter(s=>s.at<=snapshot.observedAt&&s.at+RECOVERY_WINDOW_MS>snapshot.observedAt);
    const last=recent.reduce<ForecastSpend|null>((a,b)=>!a||b.at>a.at?b:a,null);
    const basis=last?`last confirmed spend ${last.points} at ${new Date(last.at).toISOString()} (${(last.points/24).toFixed(3)} points/hour nominal)`:'no recent receipt; conservative recovery estimate';
    return new BandwidthWait(`${stage}: ${snapshot.available} free, ${target} required; ${basis}; estimated check ${nextCheckAt.toISOString()} (threshold plus one-hour buffer)`,nextCheckAt);
  }
  async prepare(from:string,to:string,amountSun:number):Promise<{txId:string;signedJson:string;bytes:number}>{
    if(!Number.isSafeInteger(amountSun)||amountSun<=0)throw Error('Invalid amount');
    if(!await this.active(to))throw Error('Recipient is not activated; transfer could incur a fee');
    // Check BEFORE building, then again using the signed transaction's exact size.
    const before=await this.bandwidthSnapshot(from);
    if(before.available<MIN_FREE_BANDWIDTH)throw await this.wait(from,before,MIN_FREE_BANDWIDTH,'Before building');
    if(MODE==='mock')return {txId:`mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,signedJson:'{}',bytes:276};
    const unsigned=await this.rpc(()=>this.tron.transactionBuilder.sendTrx(to,amountSun,from));
    if(unsigned.raw_data.contract.length!==1||unsigned.raw_data.contract[0].type!=='TransferContract')throw Error('Unexpected contract type');
    const signed=await this.tron.trx.sign(unsigned,this.keys.get(from)!);
    if(!signed.signature?.length||signed.signature.length!==1)throw Error('Expected one signature');
    // TRON's documented estimation includes protobuf wrapper, signatures and result bytes.
    const bytes=signed.raw_data_hex.length/2+3+64+67*signed.signature.length+16;
    const after=await this.bandwidthSnapshot(from);
    if(after.available<Math.max(MIN_FREE_BANDWIDTH,bytes))throw await this.wait(from,after,bytes,'Signed native transfer');
    return {txId:signed.txID,signedJson:JSON.stringify(signed),bytes};
  }
  async broadcast(from:string,to:string,amountSun:number,txId:string,signedJson:string,bytes:number):Promise<void>{
    const snapshot=await this.bandwidthSnapshot(from);
    if(snapshot.available<Math.max(MIN_FREE_BANDWIDTH,bytes))throw await this.wait(from,snapshot,bytes,'Before broadcast');
    if(!await this.active(to))throw Error('Recipient activation changed');
    if(MODE==='mock'){
      const sender=await this.db.wallet.findUniqueOrThrow({where:{address:from}});
      if(sender.balanceSnapshotSun<amountSun)throw Error('Insufficient mock balance');
      await this.db.$transaction(async tx=>{
        await tx.wallet.update({where:{address:from},data:{balanceSnapshotSun:{decrement:amountSun}}});
        if(to===this.config.teacherAddress)await tx.audit.create({data:{event:'MOCK_PAYOUT',detail:String(amountSun)}});
        else await tx.wallet.update({where:{address:to},data:{balanceSnapshotSun:{increment:amountSun}}});
      });
      return;
    }
    const signed=JSON.parse(signedJson);
    if(signed.txID!==txId)throw Error('Signed transaction ID mismatch');
    const result=await this.rpc(()=>this.tron.trx.sendRawTransaction(signed));
    // Replaying the same signed payload has the same txID and cannot create a
    // second transfer. A duplicate response still requires receipt polling.
    if(result.code==='DUP_TRANSACTION_ERROR')return;
    if(!result.result)throw Error(`Broadcast not accepted: ${String(result.code??'unknown')}`);
  }
  async rebroadcastPersisted(from:string,to:string,amountSun:number,txId:string,signedJson:string):Promise<boolean>{
    if(MODE==='mock')return true;
    const signed=JSON.parse(signedJson);
    if(signed.txID!==txId||signed.raw_data?.contract?.length!==1||signed.raw_data.contract[0].type!=='TransferContract'||signed.signature?.length!==1)throw Error('Persisted signed native transfer failed validation');
    if(!Number.isSafeInteger(signed.raw_data.expiration)||signed.raw_data.expiration<=Date.now()+5_000)return false;
    const bytes=signed.raw_data_hex.length/2+3+64+67*signed.signature.length+16;
    await this.broadcast(from,to,amountSun,txId,signedJson,bytes);
    return true;
  }
  async receipt(txId:string):Promise<Receipt>{
    if(MODE==='mock')return {found:true,success:true,feeSun:0,bandwidthUsed:260,confirmedAt:new Date()};
    // A native transfer normally has no receipt.result. Confirm its body in the
    // solidified chain, then consult the receipt for any fee or failure.
    const confirmed=await this.rpc(()=>this.tron.trx.getConfirmedTransaction(txId)).catch(()=>null);
    if(!confirmed?.txID)return {found:false,success:false,feeSun:0,bandwidthUsed:null,confirmedAt:null};
    const info=await this.rpc(()=>this.tron.trx.getTransactionInfo(txId)).catch(()=>null);
    if(!info?.id)return {found:false,success:false,feeSun:0,bandwidthUsed:null,confirmedAt:null};
    const ok=confirmed.ret?.[0]?.contractRet==='SUCCESS' && info.result!=='FAILED' && (!info.receipt?.result||info.receipt.result==='SUCCESS');
    const feeSun=Math.max(Number(info.fee??0),Number(info.receipt?.net_fee??0),Number(info.receipt?.energy_fee??0));
    // Only a confirmed receipt can tell us the actual charge; a missing field
    // must remain unknown rather than be presented as zero Bandwidth.
    const usage=info.receipt?.net_usage;
    const bandwidthUsed=Number.isSafeInteger(usage)&&usage>=0?usage:null;
    return {found:true,success:ok,feeSun,bandwidthUsed,confirmedAt:this.blockTime(info.blockTimeStamp)};
  }
}
