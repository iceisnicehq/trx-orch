import {randomInt} from 'node:crypto';
import type {EngineState,PrismaClient,Transfer,Wallet} from '@prisma/client';
import {MODE,TARGET,type Config} from './config.js';
import {settleTargets,settlementPlan} from './settlement.js';
import {BandwidthWait,TronService} from './tron.js';
import {bufferedReadyAt,MIN_FREE_BANDWIDTH} from './recovery.js';

export class HttpError extends Error {constructor(public code:number,message:string){super(message);}}
const MIN_MIX_GAP_MS=60*60_000;
const MAX_MIX_GAP_MS=2*60*60_000;
const PLAN_WINDOW_MS=24*60*60_000;
const PLAN_RETRY_MS=30*60_000;
const OPEN_MIX=['PLANNED','APPROVED','PAUSED','SUBMITTING','SUBMITTED','UNKNOWN'];
const VALID_LIST_AMOUNTS=new Set([500_000,1_000_000]);
type PoolBalance={address:string;sun:number};
type ExtraReserve={address:string;sun:number};
type PoolReview={ok:true;balances:PoolBalance[];extras:ExtraReserve[];total:number;expected:number}|{ok:false;reason:string};
const RESUMABLE_PHASES=['MIXING','REBALANCE_REQUESTED','REBALANCING','END_REQUESTED','SETTLING'];
function amountList(json:string):number[]{
  const parsed:unknown=JSON.parse(json);
  if(!Array.isArray(parsed)||parsed.length<1||parsed.length>64||!parsed.every(x=>typeof x==='number'&&VALID_LIST_AMOUNTS.has(x)))throw Error('Invalid persisted mix amount list');
  return parsed;
}
export class EngineService {
  private busy=false;
  private timer?:NodeJS.Timeout;
  constructor(private db:PrismaClient, private tron:TronService, private config:Config){}
  private async audit(event:string,detail:string,transferId?:string){await this.db.audit.create({data:{event,detail,transferId}});}
  async withLock<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new HttpError(409,'Engine is busy; retry shortly');
    this.busy=true;try{return await fn();}finally{this.busy=false;}
  }
  async init(){
    await this.db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await this.db.$queryRawUnsafe('PRAGMA busy_timeout=5000');
    const check=await this.db.$queryRawUnsafe<{quick_check:string}[]>('PRAGMA quick_check');
    if(check.length!==1||check[0].quick_check!=='ok')throw Error('SQLite integrity check failed; preserve the database and investigate before sending');
    const wallets=await this.db.wallet.findMany({orderBy:{ordinal:'asc'}});
    if(wallets.length){
      if(wallets.length!==this.config.wallets.length||wallets.some((w,i)=>w.address!==this.config.wallets[i].address))throw Error('Wallet config differs from persisted pool; refusing to start');
      const state=await this.state();
      if(state.teacherAddress!==this.config.teacherAddress)throw Error('Teacher address changed; refusing to start');
      // Preserve an already running 17-wallet game when upgrading its database.
      // An idle game has no committed pool and starts with no joined wallets.
      if(!wallets.some(w=>w.joined) && ['MIXING','END_REQUESTED','SETTLING','COMPLETE'].includes(state.phase)){
        await this.db.wallet.updateMany({data:{joined:true,mixEnabled:state.phase==='MIXING',entryBalanceSun:TARGET}});
        await this.audit('UPGRADE','Existing game retained all 17 wallets at their original 1 TRX entry balances');
      }
    }else{
      await this.db.$transaction(async tx=>{
        for(let i=0;i<this.config.wallets.length;i++)await tx.wallet.create({data:{address:this.config.wallets[i].address,ordinal:i}});
        // Retain the legacy column for existing databases; a third-party
        // recipient's unrelated balance cannot verify our individual payouts.
        await tx.engineState.create({data:{id:1,teacherAddress:this.config.teacherAddress,teacherBaseline:0,status:'Ready. Select at least two funded wallets, then Start.'}});
        await tx.audit.create({data:{event:'INITIALIZED',detail:`${this.config.wallets.length} wallets configured; mode ${MODE}`}});
      },{timeout:30_000});
    }
    const s=await this.state();
    if(s.phase==='MIXING')await this.trimLegacyMixQueue();
    if(['MIXING','REBALANCE_REQUESTED','REBALANCING','END_REQUESTED','SETTLING'].includes(s.phase))await this.withLock(()=>this.tickBody());
    this.timer=setInterval(()=>{
      if(this.busy)return;
      this.tick().catch(e=>console.error('Tick:',e.message));
    },MODE==='live'?60_000:5000);
    this.timer.unref();
  }
  private state(){return this.db.engineState.findUniqueOrThrow({where:{id:1}});}
  private async set(phase:string,status:string){await this.db.engineState.update({where:{id:1},data:{phase,status}});}
  private async fatal(reason:string){
    this.tron.invalidatePublicSnapshot();
    const old=await this.state();
    await this.db.engineState.update({where:{id:1},data:{phase:'HALTED',status:`FATAL: ${reason}`,fatalReason:reason,
      ...(old.phase!=='HALTED'?{haltedFromPhase:old.phase}:{})}});
    await this.audit('FATAL',reason);
    console.error('FATAL:',reason);
  }
  private joined(){return this.db.wallet.findMany({where:{joined:true},orderBy:{ordinal:'asc'}});}
  private async balances(wallets:Wallet[]){return Promise.all(wallets.map(async w=>({address:w.address,sun:await this.tron.balance(w.address)})));}
  private async trimLegacyMixQueue(){
    const rows=await this.db.transfer.findMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED','SUBMITTING','SUBMITTED','UNKNOWN']}},orderBy:{sequence:'asc'}});
    const occupied=new Set<string>(),extra:Transfer[]=[];
    for(const row of rows){
      if(occupied.has(row.from)){
        if(['SUBMITTING','SUBMITTED','UNKNOWN'].includes(row.status))throw Error(`Multiple in-flight MIX transfers from ${row.from}; inspect the persisted database`);
        extra.push(row);
      }else occupied.add(row.from);
    }
    const stale=rows.filter(row=>row.note?.startsWith('Bandwidth forecast:')&&!extra.some(t=>t.id===row.id));
    if(!extra.length&&!stale.length)return;
    await this.db.$transaction(async tx=>{
      for(const row of extra){
        await tx.transfer.update({where:{id:row.id},data:{status:'CANCELLED',note:'Superseded by one-pending-MIX-per-wallet queue'}});
        await tx.audit.create({data:{event:'MIX_QUEUE_TRIMMED',detail:`Cancelled unsent legacy transfer #${row.sequence} from ${row.from}; earliest pending transfer and its approval retained`,transferId:row.id}});
      }
      for(const row of stale)await tx.transfer.update({where:{id:row.id},data:{note:null}});
      if(extra.length)await tx.engineState.update({where:{id:1},data:{lastPlanAt:null}});
    });
  }
  private async inspectPool():Promise<PoolReview>{
    const joined=await this.joined();
    if(!joined.length||joined.some(w=>w.entryBalanceSun===null||w.entryBalanceSun<TARGET))return {ok:false,reason:'Pool has no valid joined-wallet baseline'};
    const b=await this.balances(joined), total=b.reduce((n,w)=>n+w.sun,0);
    if(b.some(w=>!Number.isSafeInteger(w.sun)||w.sun<0))return {ok:false,reason:'A joined wallet has an invalid balance'};
    const paid=await this.db.transfer.aggregate({where:{kind:'PAYOUT',status:'CONFIRMED'},_sum:{amountSun:true}});
    const pending=await this.db.transfer.aggregate({where:{kind:'PAYOUT',status:{in:['SUBMITTING','SUBMITTED']}},_sum:{amountSun:true}});
    const expected=joined.reduce((n,w)=>n+w.entryBalanceSun!,0)-(paid._sum.amountSun??0);
    const pendingSun=pending._sum.amountSun??0;
    if(total<expected-pendingSun||(pendingSun>0&&total>expected))
      return {ok:false,reason:`Pool invariant violated: ${total} Sun, expected ${expected}${pendingSun?` (up to ${pendingSun} in flight)`:''}`};
    // The teacher controls this address independently. Its total balance is
    // not an invariant of our pool. Payouts are counted only after their own
    // persisted txID has a successful, zero-fee confirmed receipt.
    if(pendingSun===0){
      const expectedByWallet=new Map(joined.map(w=>[w.address,w.entryBalanceSun!]));
      const confirmed=await this.db.transfer.findMany({where:{status:'CONFIRMED'},select:{from:true,to:true,amountSun:true}});
      for(const t of confirmed){
        if(!expectedByWallet.has(t.from))return {ok:false,reason:`Confirmed transfer from a wallet outside the active pool: ${t.from}`};
        expectedByWallet.set(t.from,expectedByWallet.get(t.from)!-t.amountSun);
        if(expectedByWallet.has(t.to))expectedByWallet.set(t.to,expectedByWallet.get(t.to)!+t.amountSun);
      }
      const missing=b.find(w=>w.sun<expectedByWallet.get(w.address)!);
      if(missing)return {ok:false,reason:`Wallet ${missing.address} balance is below its audited balance`};
      const extras=b.map(w=>({address:w.address,sun:w.sun-expectedByWallet.get(w.address)!})).filter(w=>w.sun>0);
      if(extras.reduce((n,w)=>n+w.sun,0)!==total-expected)
        return {ok:false,reason:'Joined pool and confirmed transfer ledger disagree'};
      if(extras.some(w=>joined.find(j=>j.address===w.address)!.entryBalanceSun!+w.sun>2_147_483_647))
        return {ok:false,reason:'Protected extra reserve exceeds the database balance range'};
      return {ok:true,balances:b,extras,total,expected};
    }
    return {ok:true,balances:b,extras:[],total,expected};
  }
  private async confirmExtraSnapshot(review:Extract<PoolReview,{ok:true}>){
    if(!review.extras.length)return;
    const fresh=await this.balances(await this.joined());
    if(fresh.length!==review.balances.length||fresh.some((w,i)=>w.address!==review.balances[i].address||w.sun!==review.balances[i].sun))
      throw new HttpError(409,'Wallet balances changed while confirming extra Sun; retry shortly');
  }
  private async saveExtraReserves(extras:ExtraReserve[],resumePhase?:string,haltReason?:string){
    const sum=extras.reduce((n,w)=>n+w.sun,0);
    await this.db.$transaction(async tx=>{
      for(const w of extras){
        await tx.wallet.update({where:{address:w.address},data:{entryBalanceSun:{increment:w.sun}}});
        await tx.audit.create({data:{event:'EXTRA_RESERVE',detail:`${w.address}: ${w.sun} newly observed Sun protected as this wallet's personal reserve; game stake unchanged`}});
      }
      await tx.engineState.update({where:{id:1},data:{status:resumePhase?
        `Verified participant balances and confirmed transfers; ${sum} extra Sun protected; resuming ${resumePhase}`:
        `Verified ${sum} new Sun as protected wallet reserves; game stake unchanged`,
        ...(resumePhase?{phase:resumePhase,fatalReason:null,haltedFromPhase:null}:{}),lastPlanAt:null}});
      if(resumePhase)await tx.audit.create({data:{event:'RESUMED',detail:`Guarded recovery from ${haltReason??'a verified halt'} to ${resumePhase}; ${sum} extra Sun protected; no transfers or approvals discarded`}});
    },{timeout:30_000});
    this.tron.invalidatePublicSnapshot();
  }
  private async reconcile(){
    const review=await this.inspectPool();
    if(!review.ok){await this.fatal(review.reason);return null;}
    if(review.extras.length){
      await this.confirmExtraSnapshot(review);
      await this.saveExtraReserves(review.extras);
    }
    return review.balances;
  }
  private async extraRecoveryPhase(s:EngineState):Promise<string|null>{
    if(s.phase!=='HALTED'||!s.fatalReason)return null;
    const numbers=/^Pool invariant violated: (\d+) Sun, expected (\d+)$/.exec(s.fatalReason);
    const oldTeacherCheck=s.fatalReason==='Teacher balance differs from attributed payouts';
    if(!oldTeacherCheck&&(!numbers||Number(numbers[1])<=Number(numbers[2])))return null;
    if(s.haltedFromPhase)return RESUMABLE_PHASES.includes(s.haltedFromPhase)?s.haltedFromPhase:null;
    // Older releases did not persist the previous phase. Infer MIXING only
    // when there is no settlement marker, open settlement row, or paid wallet.
    if(s.rebalanceFromSequence!==null||s.settlementFromSequence!==null)return null;
    const [map,payout]=await Promise.all([
      this.db.transfer.findFirst({where:{kind:{in:['REBALANCE','PAYOUT']},status:{in:['PLANNED','APPROVED','PAUSED','SUBMITTING','SUBMITTED','UNKNOWN']}}}),
      this.db.transfer.count({where:{kind:'PAYOUT',status:'CONFIRMED'}})
    ]);
    return map||payout?null:'MIXING';
  }
  private async recoveryReview(){
    const s=await this.state();
    if(s.phase!=='HALTED')throw new HttpError(409,'Recovery is available only for a halted game');
    const phase=await this.extraRecoveryPhase(s);
    if(!phase)return {eligible:false,reason:'This halt cannot be recovered automatically; investigate the original failure and any in-flight transactions',phase:null,extras:[] as ExtraReserve[],totalExtraSun:0,haltReason:s.fatalReason};
    const inFlight=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}});
    if(inFlight)return {eligible:false,reason:'An uncertain or submitted transfer must be resolved before recovery',phase:null,extras:[] as ExtraReserve[],totalExtraSun:0,haltReason:s.fatalReason};
    const review=await this.inspectPool();
    if(!review.ok)return {eligible:false,reason:review.reason,phase:null,extras:[] as ExtraReserve[],totalExtraSun:0,haltReason:s.fatalReason};
    return {eligible:true,reason:null,phase,extras:review.extras,totalExtraSun:review.extras.reduce((n,w)=>n+w.sun,0),haltReason:s.fatalReason,review};
  }
  async extraRecoveryPreview(){return this.withLock(async()=>{
    const {review:_,...preview}=await this.recoveryReview();
    return preview;
  });}
  async resumeExtraReserves(){return this.withLock(async()=>{
    const recovery=await this.recoveryReview();
    if(!recovery.eligible||!recovery.review||!recovery.phase)throw new HttpError(409,recovery.reason??'Extra reserve recovery is unavailable');
    await this.confirmExtraSnapshot(recovery.review);
    await this.saveExtraReserves(recovery.extras,recovery.phase,recovery.haltReason??undefined);
    await this.tickBody();
    return {ok:true,phase:recovery.phase,reservedSun:recovery.totalExtraSun};
  });}
  async start(){return this.withLock(async()=>{
    const s=await this.state();
    if(s.phase!=='IDLE')throw new HttpError(409,`Cannot start in ${s.phase}`);
    const selected=await this.db.wallet.findMany({where:{mixEnabled:true},orderBy:{ordinal:'asc'}});
    if(selected.length<2)throw new HttpError(409,'Select at least two funded wallets before Start');
    if(!await this.tron.active(this.config.teacherAddress))throw new HttpError(409,'Teacher account must already be activated');
    for(const w of selected)if(!await this.tron.active(w.address))throw new HttpError(409,`${w.address} is not activated`);
    const b=await this.balances(selected);
    const unfunded=b.find(w=>w.sun<TARGET);
    if(unfunded)throw new HttpError(409,`Node ${selected.find(w=>w.address===unfunded.address)!.ordinal+1} needs at least 1 TRX to join`);
    await this.db.$transaction(async tx=>{
      for(const w of b){
        await tx.wallet.update({where:{address:w.address},data:{joined:true,entryBalanceSun:w.sun}});
        await tx.audit.create({data:{event:'JOIN',detail:`${w.address} joined with 1 TRX; ${w.sun-TARGET} extra Sun reserved outside the game`}});
      }
      await tx.engineState.update({where:{id:1},data:{phase:'MIXING',status:'Creating 24-hour transfer plan'}});
      await tx.audit.create({data:{event:'START',detail:`Mixing started with ${b.length} wallets and ${b.length*TARGET} game Sun; ${b.reduce((n,w)=>n+w.sun-TARGET,0)} extra Sun reserved`}});
    },{timeout:30_000});
    await this.plan(b);
    return {ok:true};
  });}
  private async plan(b:{address:string;sun:number}[]){
    const state=await this.state();
    const enabled=await this.db.wallet.findMany({where:{joined:true,mixEnabled:true},orderBy:{ordinal:'asc'}});
    if(enabled.length<2){
      await this.db.engineState.update({where:{id:1},data:{status:'Mix paused: select at least two funded wallets',lastPlanAt:null}});
      return;
    }
    const open=await this.db.transfer.findMany({where:{kind:'MIX',status:{in:OPEN_MIX}},orderBy:{sequence:'asc'}});
    if(state.mixAmountMode==='LIST'){
      await this.planList(b,enabled,open,state.mixAmountList,state.mixAmountCursor,state.mixLastReceiver);
      return;
    }
    const occupied=new Set(open.map(t=>t.from));
    const candidates=enabled.filter(w=>!occupied.has(w.address)).map(w=>({address:w.address,sun:b.find(x=>x.address===w.address)!.sun-(w.entryBalanceSun!-TARGET)}))
      .filter(w=>w.sun>100_000);
    const now=Date.now();
    const lastScheduled=open.reduce((last,t)=>Math.max(last,t.scheduledAt.getTime()),now);
    let scheduledAt=lastScheduled;
    const rows:{kind:string;status:string;from:string;to:string;amountSun:number;scheduledAt:Date}[]=[];
    if(!candidates.length){
      await this.db.engineState.update({where:{id:1},data:{lastPlanAt:new Date(now),status:open.length?'Waiting for scheduled mix transfers or approvals':'Waiting for an eligible funded sender'}});
      return;
    }
    // Only known, already-confirmed resource use can enter a wallet's forecast.
    // A second outgoing row from the same sender is created after its current
    // transaction confirms; no hypothetical Bandwidth charge is assumed.
    const observations=await Promise.all(candidates.map(w=>this.tron.bandwidthSnapshot(w.address)));
    const recentSpends=await Promise.all(candidates.map(w=>this.tron.recentBandwidthSpends(w.address)));
    while(candidates.length){
      const candidateTime=scheduledAt+randomInt(MIN_MIX_GAP_MS,MAX_MIX_GAP_MS+1);
      if(candidateTime>=now+PLAN_WINDOW_MS)break;
      const readiness=candidates.map((_,j)=>({j,at:bufferedReadyAt(observations[j].limit,observations[j].available,observations[j].observedAt,candidateTime,MIN_FREE_BANDWIDTH,recentSpends[j])}))
        .filter((item):item is {j:number;at:number}=>item.at!==null);
      if(!readiness.length)break;
      const ready=readiness.filter(item=>item.at<=candidateTime);
      const choice=ready.length?ready[randomInt(ready.length)]:readiness.reduce((a,b)=>a.at<=b.at?a:b);
      scheduledAt=Math.max(candidateTime,choice.at);
      if(scheduledAt>=now+PLAN_WINDOW_MS)break;
      const from=candidates[choice.j];
      const peers=enabled.filter(w=>w.address!==from.address);
      const to=peers[randomInt(peers.length)].address;
      const amount=Math.min(from.sun-100_000,randomInt(10_000,150_001));
      rows.push({kind:'MIX',status:'PLANNED',from:from.address,to,amountSun:amount,scheduledAt:new Date(scheduledAt)});
      candidates.splice(choice.j,1);observations.splice(choice.j,1);recentSpends.splice(choice.j,1);
    }
    if(rows.length)await this.insert(rows,{
      status:`Rolling 24-hour queue: ${rows.length} new transfer${rows.length===1?'':'s'}; at most one pending MIX per sender`,
      lastPlanAt:new Date(now),event:'PLAN',detail:`${rows.length} transfers added within the next 24 hours; one pending MIX per sender`
    });
    else await this.db.engineState.update({where:{id:1},data:{lastPlanAt:new Date(now),status:'Waiting for bandwidth recovery or the next 24-hour planning window'}});
  }
  private async planList(b:{address:string;sun:number}[],enabled:Wallet[],open:Transfer[],json:string,cursor:number,lastReceiver:string|null){
    const now=Date.now();
    if(open.length){
      await this.db.engineState.update({where:{id:1},data:{lastPlanAt:new Date(now),status:'List mode: waiting for the current chain step'}});
      return;
    }
    const amounts=amountList(json),amount=amounts[cursor%amounts.length];
    const candidates=enabled.filter(w=>b.find(x=>x.address===w.address)!.sun-(w.entryBalanceSun!-TARGET)>=amount);
    if(!candidates.length){
      await this.db.engineState.update({where:{id:1},data:{lastPlanAt:new Date(now),status:`List mode: waiting for a sender with ${(amount/TARGET).toFixed(1)} TRX of game balance`}});
      return;
    }
    // A completed LIST transfer is the only input to the next choice. Check
    // every enabled wallet once, including potential receivers, using live
    // free-quota snapshots; dashboard snapshots may be up to two minutes old.
    const snapshots=await Promise.all(enabled.map(w=>this.tron.bandwidthSnapshot(w.address)));
    const resources=new Map(enabled.map((w,i)=>[w.address,snapshots[i]]));
    const choose=(wallets:Wallet[],value:(w:Wallet)=>number,prefer?:string)=>{
      const best=Math.max(...wallets.map(value));
      const tied=wallets.filter(w=>value(w)===best);
      return tied.find(w=>w.address===prefer)??tied[randomInt(tied.length)];
    };
    const readySenders=candidates.filter(w=>resources.get(w.address)!.available>=MIN_FREE_BANDWIDTH);
    let from:Wallet|undefined,readyAt:number|undefined;
    if(readySenders.length){
      // Fresh accounts are useful before consuming more of a partially
      // recovered account. The previous recipient retains priority on ties.
      from=choose(readySenders,w=>resources.get(w.address)!.available,lastReceiver??undefined);
      readyAt=now;
    }else{
      // No wallet can send now. Forecast only confirmed resource use and
      // choose the earliest recoverable sender with the usual hour buffer.
      const options=await Promise.all(candidates.map(async w=>({wallet:w,at:bufferedReadyAt(
        resources.get(w.address)!.limit,resources.get(w.address)!.available,resources.get(w.address)!.observedAt,
        now,MIN_FREE_BANDWIDTH,await this.tron.recentBandwidthSpends(w.address))})));
      const eligible=options.filter((o):o is {wallet:Wallet;at:number}=>o.at!==null&&o.at<now+PLAN_WINDOW_MS);
      if(eligible.length){
        const soonest=Math.min(...eligible.map(o=>o.at));
        const closest=eligible.filter(o=>o.at===soonest).map(o=>o.wallet);
        from=choose(closest,w=>resources.get(w.address)!.available,lastReceiver??undefined);
        readyAt=soonest;
      }
    }
    if(!from||readyAt===undefined){
      await this.db.engineState.update({where:{id:1},data:{lastPlanAt:new Date(now),status:'List mode: waiting for free Bandwidth within the planning window'}});
      return;
    }
    const nextAmount=amounts[(cursor+1)%amounts.length];
    const peers=enabled.filter(w=>w.address!==from.address);
    const fundedPeers=peers.filter(w=>b.find(x=>x.address===w.address)!.sun-(w.entryBalanceSun!-TARGET)+amount>=nextAmount);
    const to=choose(fundedPeers.length?fundedPeers:peers,w=>resources.get(w.address)!.available);
    await this.insert([{kind:'MIX',status:'PLANNED',from:from.address,to:to.address,amountSun:amount,scheduledAt:new Date(readyAt)}],{
      status:`List mode: next ${(amount/TARGET).toFixed(1)} TRX step queued ${readyAt===now?'for immediate review':'after predicted bandwidth recovery'}; ${cursor+1} confirmed steps after completion`,
      lastPlanAt:new Date(now),event:'PLAN',detail:`LIST step ${(amount/TARGET).toFixed(1)} TRX ${from.address} → ${to.address}; next step waits for this receipt`
    });
  }
  private async insert(rows:{kind:string;status:string;from:string;to:string;amountSun:number;scheduledAt:Date;note?:string}[],
    transition:{status:string;phase?:string;lastPlanAt?:Date;event:string;detail:string}){
    const s=await this.state();
    const wallets=await this.db.wallet.findMany();const auto=new Map(wallets.map(w=>[w.address,w.autoApprove]));
    await this.db.$transaction(async tx=>{
      for(let i=0;i<rows.length;i++){
        const r=rows[i];const status=auto.get(r.from)?'APPROVED':'PLANNED';
        const t=await tx.transfer.create({data:{...r,status,sequence:s.nextSequence+i}});
        await tx.audit.create({data:{event:'QUEUED',detail:`${r.kind} ${r.amountSun} Sun ${r.from} → ${r.to}; ${status}`,transferId:t.id}});
      }
      await tx.engineState.update({where:{id:1},data:{nextSequence:s.nextSequence+rows.length,status:transition.status,
        ...(transition.phase?{phase:transition.phase}:{}),...(transition.lastPlanAt?{lastPlanAt:transition.lastPlanAt}:{})}});
      await tx.audit.create({data:{event:transition.event,detail:transition.detail}});
    },{timeout:30_000});
  }
  async end(){return this.withLock(async()=>{
    const s=await this.state();
    if(s.phase==='END_REQUESTED'||s.phase==='SETTLING')return {ok:true};
    if(!['MIXING','REBALANCE_REQUESTED','REBALANCING'].includes(s.phase))throw new HttpError(409,`Cannot end in ${s.phase}`);
    await this.db.$transaction(async tx=>{
      await tx.engineState.update({where:{id:1},data:{phase:'END_REQUESTED',settlementFromSequence:s.nextSequence,
        rebalanceFromSequence:null,lastPlanAt:null,status:'Ending mix; reconciling any in-flight transfer'}});
      await tx.transfer.updateMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},data:{status:'CANCELLED',note:'End requested'}});
      await tx.transfer.updateMany({where:{kind:'REBALANCE',status:{in:['PLANNED','APPROVED','PAUSED']}},data:{status:'CANCELLED',note:'End requested during rebalance'}});
      await tx.wallet.updateMany({where:{joined:false},data:{mixEnabled:false}});
      await tx.audit.create({data:{event:'END_REQUESTED',detail:'Mixing stopped; awaiting reconciliation'}});
    });
    await this.tickBody();return {ok:true};
  });}
  private async rebalanceSteps(b:{address:string;sun:number}[]){
    const joined=await this.joined();
    return settleTargets(b.map(w=>({address:w.address,sun:w.sun,
      targetSun:joined.find(j=>j.address===w.address)!.entryBalanceSun!})));
  }
  async rebalancePreview(){return this.withLock(async()=>{
    const s=await this.state();
    if(s.phase!=='MIXING')throw new HttpError(409,`Cannot preview rebalance in ${s.phase}`);
    const inFlight=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}});
    if(inFlight){
      if(inFlight.status==='UNKNOWN')throw new HttpError(409,'Uncertain transaction requires manual investigation');
      return {pendingReceipt:true,transferCount:null,steps:[]};
    }
    const b=await this.reconcile();
    if(!b)throw new HttpError(409,'Pool invariant violated; engine halted');
    const steps=await this.rebalanceSteps(b);
    return {pendingReceipt:false,transferCount:steps.length,steps};
  });}
  async rebalance(){return this.withLock(async()=>{
    const s=await this.state();
    if(['REBALANCE_REQUESTED','REBALANCING'].includes(s.phase))return {ok:true};
    if(s.phase!=='MIXING')throw new HttpError(409,`Cannot rebalance in ${s.phase}`);
    const inFlight=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}});
    if(inFlight?.status==='UNKNOWN')throw new HttpError(409,'Resolve the uncertain transaction before rebalancing');
    if(!inFlight&&!await this.reconcile())throw new HttpError(409,'Pool invariant violated; engine halted');
    await this.db.$transaction(async tx=>{
      await tx.engineState.update({where:{id:1},data:{phase:'REBALANCE_REQUESTED',rebalanceFromSequence:s.nextSequence,
        lastPlanAt:null,status:'Rebalance requested; waiting for any in-flight transfer'}});
      const cancelled=await tx.transfer.updateMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},
        data:{status:'CANCELLED',note:'Rebalance requested; mix paused'}});
      await tx.audit.create({data:{event:'REBALANCE_REQUESTED',detail:`Paused mixing and cancelled ${cancelled.count} unsent MIX transfers; waiting for a confirmed balance snapshot`}});
    });
    await this.tickBody();return {ok:true};
  });}
  async setMixAmounts(mode:'RANDOM'|'LIST',amountsSun?:number[]){return this.withLock(async()=>{
    if(!['RANDOM','LIST'].includes(mode)||amountsSun&&(!amountsSun.length||amountsSun.length>64||amountsSun.some(n=>!VALID_LIST_AMOUNTS.has(n))))
      throw new HttpError(400,'List must contain 1 or 0.5 TRX per line, with 1–64 lines');
    const s=await this.state();
    if(!['IDLE','MIXING'].includes(s.phase))throw new HttpError(409,`Cannot change mix amounts in ${s.phase}`);
    const current=amountList(s.mixAmountList);
    const list=amountsSun??current;
    if(mode==='LIST'&&!list.length)throw new HttpError(400,'Enter at least one amount');
    if(s.mixAmountMode===mode&&JSON.stringify(current)===JSON.stringify(list))return {ok:true};
    if(s.phase==='MIXING'){
      const inFlight=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}});
      if(inFlight)throw new HttpError(409,'Wait for the in-flight transfer to confirm before changing amount mode');
      if(!await this.reconcile())throw new HttpError(409,'Pool invariant violated; engine halted');
    }
    await this.db.$transaction(async tx=>{
      if(s.phase==='MIXING')await tx.transfer.updateMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},
        data:{status:'CANCELLED',note:'Mix amount mode changed; earlier approvals cancelled'}});
      await tx.engineState.update({where:{id:1},data:{mixAmountMode:mode,mixAmountList:JSON.stringify(list),mixAmountCursor:0,
        mixLastReceiver:null,lastPlanAt:null,status:s.phase==='MIXING'?'Mix amount mode updated; building a new queue':'Mix amount mode saved for Start'}});
      await tx.audit.create({data:{event:'MIX_AMOUNT_MODE',detail:`${mode}; list ${list.map(n=>`${n/TARGET} TRX`).join(', ')}; prior unsent approvals cancelled`}});
    });
    if(s.phase==='MIXING')await this.tickBody();
    return {ok:true};
  });}
  async replan(){return this.withLock(async()=>{
    const s=await this.state();
    if(s.phase!=='MIXING')throw new HttpError(409,`Cannot replan in ${s.phase}`);
    const inFlight=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}});
    if(inFlight?.status==='UNKNOWN')throw new HttpError(409,'Resolve the uncertain transaction before replanning');
    if(!inFlight&&!await this.reconcile())throw new HttpError(409,'Pool invariant violated; engine halted');
    await this.db.$transaction(async tx=>{
      const cancelled=await tx.transfer.updateMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},data:{status:'CANCELLED',note:'Admin requested a new random schedule'}});
      await tx.engineState.update({where:{id:1},data:{lastPlanAt:null,status:'Replanning remaining mix transfers after any in-flight transaction'}});
      await tx.audit.create({data:{event:'REPLAN_REQUESTED',detail:`Cancelled ${cancelled.count} unsent MIX transfers; prior approvals do not carry over`}});
    });
    await this.tickBody();
    return {ok:true};
  });}
  private async createSettlement(b:{address:string;sun:number}[]){
    const joined=await this.joined();
    const balances=b.map(w=>({
      ...w,reserveSun:joined.find(j=>j.address===w.address)!.entryBalanceSun!-TARGET
    }));
    const steps=settlementPlan(balances,this.config.teacherAddress);
    const now=new Date();
    const rows=steps.map(x=>({...x,status:'PLANNED',scheduledAt:now}));
    await this.insert(rows,{
      phase:'SETTLING',status:`Settlement map ready: ${steps.filter(s=>s.kind==='REBALANCE').length} balancing transfers and ${b.length} exact 1 TRX payouts; protected extra Sun stays in each wallet`,
      event:'SETTLEMENT_MAP',detail:`${steps.length} steps for ${b.length} joined wallets; ${balances.reduce((n,w)=>n+w.reserveSun,0)} extra Sun excluded from the game`
    });
  }
  private async createRebalance(b:{address:string;sun:number}[]){
    const steps=await this.rebalanceSteps(b);
    await this.insert(steps.map(x=>({...x,kind:'REBALANCE',status:'PLANNED',scheduledAt:new Date()})),{
      phase:'REBALANCING',status:`Rebalance map: ${steps.length} transfers to return all joined wallets to exactly 1 TRX plus their protected extra Sun`,
      event:'REBALANCE_MAP',detail:`${steps.length} exact balancing transfers; no teacher payouts; mixing resumes after confirmation`
    });
  }
  async setMixEnabled(address:string,enabled:boolean){return this.withLock(async()=>{
    const s=await this.state();
    if(!['IDLE','MIXING'].includes(s.phase))throw new HttpError(409,`Cannot change participants in ${s.phase}`);
    const wallet=await this.db.wallet.findUnique({where:{address}});
    if(!wallet)throw new HttpError(404,'Wallet not found');
    if(wallet.mixEnabled===enabled)return {ok:true};
    if(enabled&&!wallet.joined){
      if(!await this.tron.active(address))throw new HttpError(409,`Node ${wallet.ordinal+1} is not activated`);
      if(await this.tron.balance(address)<TARGET)throw new HttpError(409,`Node ${wallet.ordinal+1} needs at least 1 TRX to join`);
    }
    if(s.phase==='MIXING'){
      const inFlight=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}});
      if(inFlight?.status==='UNKNOWN')throw new HttpError(409,'Resolve the uncertain transaction before changing participants');
      // A pending mix can already have moved money on chain. Reconcile only
      // after its persisted txID is confirmed, inside tickBody.
      if(!inFlight&&!await this.reconcile())throw new HttpError(409,'Pool invariant violated; engine halted');
    }
    await this.db.$transaction(async tx=>{
      await tx.wallet.update({where:{address},data:{mixEnabled:enabled}});
      if(s.phase==='MIXING'){
        await tx.transfer.updateMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},data:{status:'CANCELLED',note:'Participant selection changed; plan recalculated'}});
        await tx.engineState.update({where:{id:1},data:{lastPlanAt:null,status:'Selection changed; replanning after any in-flight transfer'}});
      }else{
        await tx.engineState.update({where:{id:1},data:{status:'Ready. Select at least two funded wallets, then Start.'}});
      }
      await tx.audit.create({data:{event:'PARTICIPANT_SELECTION',detail:`Node ${wallet.ordinal+1} ${address}: ${enabled?'enabled':'disabled'} for future mixing${wallet.joined?' (stays in settlement pool)':''}`}});
    });
    this.tron.invalidatePublicSnapshot();
    await this.tickBody();return {ok:true};
  });}
  private async joinSelected():Promise<boolean>{
    const pending=await this.db.wallet.findMany({where:{mixEnabled:true,joined:false},orderBy:{ordinal:'asc'}});
    if(!pending.length)return false;
    for(const w of pending){
      // In-flight transactions finish first. A newly selected wallet is added
      // to the invariant only after a fresh balance and activation check.
      const active=await this.tron.active(w.address);
      const balance=active?await this.tron.balance(w.address):0;
      if(balance<TARGET){
        await this.db.wallet.update({where:{address:w.address},data:{mixEnabled:false}});
        await this.audit('JOIN_REJECTED',`Node ${w.ordinal+1} no longer has an activated account with at least 1 TRX`);
        continue;
      }
      await this.db.$transaction(async tx=>{
        await tx.wallet.update({where:{address:w.address},data:{joined:true,entryBalanceSun:balance}});
        await tx.audit.create({data:{event:'JOIN',detail:`${w.address} joined with 1 TRX; ${balance-TARGET} extra Sun reserved outside the game`}});
      });
      this.tron.invalidatePublicSnapshot();
    }
    return true;
  }
  async approve(id:string){return this.withLock(async()=>{
    const s=await this.state();if(s.phase==='HALTED'||s.phase==='COMPLETE')throw new HttpError(409,'Engine is halted or complete');
    const t=await this.db.transfer.findUnique({where:{id}});
    if(!t||t.status!=='PLANNED')throw new HttpError(409,'Transfer is no longer awaiting approval');
    await this.db.transfer.update({where:{id},data:{status:'APPROVED'}});
    await this.audit('APPROVED',`Manual approval: ${t.kind} ${t.amountSun} Sun ${t.from} → ${t.to}`,id);
    await this.tickBody();return {ok:true};
  });}
  async autoApprove(address:string,enabled:boolean){return this.withLock(async()=>{
    const wallet=await this.db.wallet.findUnique({where:{address}});if(!wallet)throw new HttpError(404,'Wallet not found');
    await this.db.$transaction(async tx=>{
      await tx.wallet.update({where:{address},data:{autoApprove:enabled}});
      if(enabled)await tx.transfer.updateMany({where:{from:address,status:'PLANNED'},data:{status:'APPROVED'}});
      await tx.audit.create({data:{event:'AUTOAPPROVE',detail:`${address}: ${enabled?'enabled':'disabled'}`}});
    });
    await this.tickBody();return {ok:true};
  });}
  private async resolveInFlight(t:Transfer){
    const r=await this.tron.receipt(t.txId!);
    if(!r.found){
      // An outage during or after broadcast is ambiguous. Reuse the persisted
      // txID for recovery; never sign a replacement based on a missing receipt.
      if(t.status==='SUBMITTING'&&t.signedJson&&Date.now()-t.updatedAt.getTime()>30_000){
        try{
          const retried=await this.tron.rebroadcastPersisted(t.from,t.to,t.amountSun,t.txId!,t.signedJson);
          if(retried){
            await this.db.$transaction(async tx=>{
              await tx.transfer.update({where:{id:t.id},data:{status:'SUBMITTED',note:'Same signed transaction retried; awaiting chain confirmation'}});
              await tx.audit.create({data:{event:'REBROADCAST',detail:`Retried original txID ${t.txId} without re-signing`,transferId:t.id}});
            });
            await this.db.engineState.update({where:{id:1},data:{status:`Rebroadcast original tx ${t.txId}; waiting for confirmation`}});
            return;
          }
        }catch(e){
          // A retry can fail because the node is offline, bandwidth is low,
          // or the transaction was already seen. Keep the original txID.
          console.error('Recovery rebroadcast:',e instanceof Error?e.message:String(e));
        }
      }
      if(Date.now()-t.updatedAt.getTime()>15*60_000){
        await this.db.transfer.update({where:{id:t.id},data:{status:'UNKNOWN',note:'Receipt still absent after recovery window; inspect persisted txID and signed payload'}});
        await this.fatal(`Receipt unresolved for ${t.txId}; manual chain investigation required`);
      }else await this.db.engineState.update({where:{id:1},data:{status:`Recovering ${t.status.toLowerCase()} tx ${t.txId}; waiting for chain confirmation`}});
      return;
    }
    if(!r.success||r.feeSun!==0){
      await this.db.transfer.update({where:{id:t.id},data:{status:'UNKNOWN',note:`Receipt: success ${r.success}, fee ${r.feeSun} Sun`}});
      await this.fatal(`Transaction ${t.txId} failed or cost ${r.feeSun} Sun`);return;
    }
    await this.db.$transaction(async tx=>{
      await tx.transfer.update({where:{id:t.id},data:{status:'CONFIRMED',signedJson:null,bandwidthUsed:r.bandwidthUsed,confirmedAt:r.confirmedAt,note:`Confirmed: fee 0 Sun; ${r.bandwidthUsed===null?'Bandwidth not reported by node':`${r.bandwidthUsed} Bandwidth used`}`}});
      // Keep the refill request in the same durable commit as the receipt.
      // If planning or the process fails next, startup retries with actual
      // resource data instead of leaving this sender without a queue slot.
      if(t.kind==='MIX'){
        const state=await tx.engineState.findUniqueOrThrow({where:{id:1},select:{mixAmountMode:true}});
        await tx.engineState.update({where:{id:1},data:{lastPlanAt:null,
          ...(state.mixAmountMode==='LIST'?{mixAmountCursor:{increment:1},mixLastReceiver:t.to}:{})}});
      }
      await tx.audit.create({data:{event:'CONFIRMED',detail:`${t.kind}: ${t.amountSun} Sun, fee 0; ${r.bandwidthUsed===null?'Bandwidth unavailable':`${r.bandwidthUsed} Bandwidth used`}; tx ${t.txId}`,transferId:t.id}});
    });
    this.tron.invalidatePublicSnapshot();
  }
  async tick(){return this.withLock(()=>this.tickBody());}
  private async tickBody(){
    let s=await this.state();
    if(['IDLE','COMPLETE','HALTED'].includes(s.phase))return;
    try{
      const active=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}},orderBy:{sequence:'asc'}});
      let justConfirmed=false;
      if(active){if(active.status==='UNKNOWN'){await this.fatal('Ambiguous transaction requires manual investigation');return;}
        await this.resolveInFlight(active);
        if((await this.state()).phase==='HALTED')return;
        if((await this.db.transfer.findUniqueOrThrow({where:{id:active.id}})).status!=='CONFIRMED')return;
        justConfirmed=true;
      }
      let b=await this.reconcile();if(!b)return;
      s=await this.state();
      if(s.phase==='MIXING'&&await this.joinSelected()){
        b=await this.reconcile();if(!b)return;
      }
      if(s.phase==='END_REQUESTED'){
        const existing=await this.db.transfer.count({where:{kind:{in:['REBALANCE','PAYOUT']},
          ...(s.settlementFromSequence!==null?{sequence:{gte:s.settlementFromSequence}}:{})}});
        if(existing){
          // Also recover a map created by an older image between its separate
          // insert and phase-update calls. Never duplicate settlement transfers.
          await this.set('SETTLING','Recovered persisted settlement map after restart');
          await this.audit('SETTLEMENT_RECOVERED','Reused previously stored settlement queue');
        }else await this.createSettlement(b);
        s=await this.state();
      }
      if(s.phase==='REBALANCE_REQUESTED'){
        if(s.rebalanceFromSequence===null)throw Error('Rebalance sequence marker is missing');
        const existing=await this.db.transfer.count({where:{kind:'REBALANCE',sequence:{gte:s.rebalanceFromSequence}}});
        if(existing){
          await this.set('REBALANCING','Recovered persisted rebalance map after restart');
          await this.audit('REBALANCE_RECOVERED','Reused the previously stored rebalance queue');
        }else await this.createRebalance(b);
        s=await this.state();
      }
      if(s.phase==='MIXING'&&(justConfirmed||!s.lastPlanAt||Date.now()-s.lastPlanAt.getTime()>=PLAN_RETRY_MS))await this.plan(b);
      const next=await this.db.transfer.findFirst({where:{status:{in:['PLANNED','APPROVED','PAUSED']},
        kind:{in:s.phase==='MIXING'?['MIX']:s.phase==='REBALANCING'?['REBALANCE']:['REBALANCE','PAYOUT']},
        ...(s.phase==='REBALANCING'&&s.rebalanceFromSequence!==null?{sequence:{gte:s.rebalanceFromSequence}}:{}),
        ...(s.phase==='SETTLING'&&s.settlementFromSequence!==null?{sequence:{gte:s.settlementFromSequence}}:{})},orderBy:{sequence:'asc'}});
      if(!next){
        if(s.phase==='REBALANCING'){
          const joined=await this.joined();
          if(b.some(w=>w.sun!==joined.find(j=>j.address===w.address)!.entryBalanceSun!)){
            await this.fatal('Rebalance queue exhausted before restoring every joined wallet');return;
          }
          const count=await this.db.transfer.count({where:{kind:'REBALANCE',status:'CONFIRMED',sequence:{gte:s.rebalanceFromSequence!}}});
          await this.db.$transaction(async tx=>{
            await tx.engineState.update({where:{id:1},data:{phase:'MIXING',rebalanceFromSequence:null,
              lastPlanAt:null,mixAmountCursor:0,mixLastReceiver:null,
              status:`Rebalance complete: ${count} transfers; each joined wallet again has 1 TRX plus its protected extra Sun`}});
            await tx.audit.create({data:{event:'REBALANCE_COMPLETE',detail:`${count} transfers confirmed; each joined wallet restored; mixing resumed`}});
          });
          await this.plan(b);
          return;
        }
        if(s.phase==='SETTLING'){
          const joined=await this.joined();
          if(b.some(w=>w.sun!==joined.find(j=>j.address===w.address)!.entryBalanceSun!-TARGET)){await this.fatal('Settlement queue exhausted without restoring protected extra Sun');return;}
          await this.db.$transaction(async tx=>{
            await tx.engineState.update({where:{id:1},data:{phase:'COMPLETE',status:'Complete: each joined wallet sent exactly 1 TRX; protected extra Sun remains in its wallet'}});
            await tx.audit.create({data:{event:'COMPLETE',detail:'All joined-wallet 1 TRX payouts confirmed'}});
          });
        }
        return;
      }
      if(next.status==='PLANNED'){await this.db.engineState.update({where:{id:1},data:{status:`Awaiting approval: ${next.kind.toLowerCase()} #${next.sequence} from ${next.from}`}});return;}
      if(next.scheduledAt.getTime()>Date.now())return;
      if(next.kind==='MIX'&&s.mixAmountMode==='RANDOM'){
        const last=await this.db.transfer.findFirst({where:{kind:'MIX',status:'CONFIRMED'},orderBy:{updatedAt:'desc'},select:{updatedAt:true}});
        if(last&&Date.now()-last.updatedAt.getTime()<MIN_MIX_GAP_MS){
          await this.db.engineState.update({where:{id:1},data:{status:`Waiting between mix transfers until ${new Date(last.updatedAt.getTime()+MIN_MIX_GAP_MS).toISOString()}`}});
          return;
        }
      }
      const sender=b.find(w=>w.address===next.from)!;
      const senderWallet=await this.db.wallet.findUniqueOrThrow({where:{address:next.from}});
      const reserve=senderWallet.entryBalanceSun!-TARGET;
      if(sender.sun-reserve<next.amountSun){
        // Forecast assumed earlier approvals; never send when live balance disagrees.
        await this.db.transfer.update({where:{id:next.id},data:{status:'PAUSED',note:'Live balance insufficient; manual investigation required'}});
        await this.fatal(`Insufficient game balance for transfer #${next.sequence}; extra Sun is reserved`);return;
      }
      if(next.kind==='PAYOUT'&&sender.sun!==senderWallet.entryBalanceSun){await this.fatal(`Payout wallet ${next.from} holds ${sender.sun}, expected ${senderWallet.entryBalanceSun} including reserved Sun`);return;}
      await this.db.engineState.update({where:{id:1},data:{status:`Preflight ${next.kind.toLowerCase()} #${next.sequence} from ${next.from}`}});
      let prepared;
      try{prepared=await this.tron.prepare(next.from,next.to,next.amountSun);}catch(e){
        if(e instanceof BandwidthWait){
          await this.db.transfer.update({where:{id:next.id},data:{note:`Bandwidth: ${e.message}`,scheduledAt:e.nextCheckAt}});
          await this.db.engineState.update({where:{id:1},data:{status:`Waiting for bandwidth: ${next.from}; ${e.message}`}});return;
        }throw e;
      }
      // Persist tx ID BEFORE broadcast. Any crash/error from this point pauses, never rebuilds.
      await this.db.transfer.update({where:{id:next.id},data:{status:'SUBMITTING',txId:prepared.txId,signedJson:prepared.signedJson,note:`Preflight ${prepared.bytes} bytes`}});
      try{
        await this.tron.broadcast(next.from,next.to,next.amountSun,prepared.txId,prepared.signedJson,prepared.bytes);
        await this.db.transfer.update({where:{id:next.id},data:{status:'SUBMITTED'}});
        await this.audit('SUBMITTED',`${next.kind} #${next.sequence} tx ${prepared.txId}`,next.id);
        await this.db.engineState.update({where:{id:1},data:{status:`Waiting for receipt: ${next.kind.toLowerCase()} #${next.sequence}`}});
      }catch(e){
        if(e instanceof BandwidthWait){
          // This typed error is thrown before any network broadcast call.
          await this.db.transfer.update({where:{id:next.id},data:{status:'APPROVED',txId:null,signedJson:null,note:`Bandwidth changed before broadcast: ${e.message}`,scheduledAt:e.nextCheckAt}});
          await this.db.engineState.update({where:{id:1},data:{status:`Waiting for bandwidth before transfer #${next.sequence}: ${e.message}`}});
          return;
        }
        // The node may have accepted the signed transaction despite an RPC
        // error. Keep its ID and wait for chain evidence, even after a restart.
        await this.db.transfer.update({where:{id:next.id},data:{note:`Broadcast outcome uncertain: ${String(e)}`}});
        await this.audit('BROADCAST_UNCERTAIN',`Persisted tx ${prepared.txId}; polling without rebroadcast`,next.id);
        await this.db.engineState.update({where:{id:1},data:{status:`Broadcast response uncertain for ${prepared.txId}; recovering by txID`}});
      }
    }catch(e){
      // RPC outages cannot be treated as a zero balance. Pause, preserve queue and retry.
      if((await this.state()).phase!=='HALTED')await this.db.engineState.update({where:{id:1},data:{status:`RPC unavailable or preflight failed: ${String(e)}; retrying safely`}});
      console.error('Engine tick:',e instanceof Error?e.message:String(e));
    }
  }
}
