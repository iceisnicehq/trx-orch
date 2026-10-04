import {randomInt,randomBytes,randomUUID} from 'node:crypto';
import {TronWeb} from 'tronweb';
import type {EngineState,Prisma,PrismaClient,Transfer,Wallet} from '@prisma/client';
import {MODE,TARGET,type Config} from './config.js';
import {settleTargets,settlementPlan} from './settlement.js';
import {BandwidthWait,TronService,type BandwidthSnapshot,type BandwidthPolicy} from './tron.js';
import {bufferedReadyAt,MIN_FREE_BANDWIDTH} from './recovery.js';
import {DAY,type CampaignPlan} from './campaign-plan.js';
import {applyConfirmedOwnership,verifyOwnership,attributedReturns,OwnershipError} from './ownership.js';
import {buildBalancedPlan,loadVariant,saveVariant,swapPlan,serializePlan,preparationPermission} from './plan-variants.js';
import {ADAPTIVE_BANDWIDTH,RESOURCE_PROBE_MS,adaptiveMixForecast,adaptiveReturnForecast,chooseGap,gapRange,type TimingWallet} from './adaptive-timing.js';

export class HttpError extends Error {constructor(public code:number,message:string){super(message);}}
const MIN_MIX_GAP_MS=60*60_000;
const MAX_MIX_GAP_MS=2*60*60_000;
const PLAN_WINDOW_MS=24*60*60_000;
const PLAN_RETRY_MS=30*60_000;
const OPEN_MIX=['PLANNED','APPROVED','PAUSED','SUBMITTING','SUBMITTED','UNKNOWN'];
const CAMPAIGN_PHASES=['CAMPAIGN','CAMPAIGN_RETURN_REQUESTED','CAMPAIGN_RETURNING','CAMPAIGN_RESTORED'];
const VALID_LIST_AMOUNTS=new Set([500_000,1_000_000]);
type PoolBalance={address:string;sun:number};
type ExtraReserve={address:string;sun:number};
type PoolReview={ok:true;balances:PoolBalance[];extras:ExtraReserve[];total:number;expected:number}|{ok:false;reason:string};
const RESUMABLE_PHASES=['MIXING','LEGACY_PAUSED','REBALANCE_REQUESTED','REBALANCING','END_REQUESTED','SETTLING',...CAMPAIGN_PHASES];
function amountList(json:string):number[]{
  const parsed:unknown=JSON.parse(json);
  if(!Array.isArray(parsed)||parsed.length<1||parsed.length>64||!parsed.every(x=>typeof x==='number'&&VALID_LIST_AMOUNTS.has(x)))throw Error('Invalid persisted mix amount list');
  return parsed;
}
export class EngineService {
  private busy=false;
  private timer?:NodeJS.Timeout;
  private wakeTimer?:NodeJS.Timeout;
  private wakeAt=0;
  private stopped=false;
  private timingRevision='';
  private timingResources?:{campaignId:string;wallets:Map<string,TimingWallet>};
  constructor(private db:PrismaClient, private tron:TronService, private config:Config,private campaignOnly=false){}
  stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);if(this.wakeTimer)clearTimeout(this.wakeTimer);this.timer=undefined;this.wakeTimer=undefined;this.wakeAt=0;}
  private wake(at:Date){
    if(this.stopped)return;
    const when=Math.max(Date.now()+1000,at.getTime());
    if(this.wakeTimer&&this.wakeAt<=when)return;
    if(this.wakeTimer)clearTimeout(this.wakeTimer);
    this.wakeAt=when;
    this.wakeTimer=setTimeout(()=>{
      this.wakeTimer=undefined;this.wakeAt=0;
      if(this.busy){this.wake(new Date(Date.now()+5000));return;}
      this.tick().catch(e=>console.error('Timing tick:',e.message));
    },Math.min(when-Date.now(),2_147_000_000));
    this.wakeTimer.unref();
  }
  private async audit(event:string,detail:string,transferId?:string){await this.db.audit.create({data:{event,detail,transferId}});}
  async withLock<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new HttpError(409,'Engine is busy; retry shortly');
    this.busy=true;try{return await fn();}finally{this.busy=false;}
  }
  async init(){
    this.stopped=false;
    await this.db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await this.db.$queryRawUnsafe('PRAGMA busy_timeout=5000');
    const check=await this.db.$queryRawUnsafe<{quick_check:string}[]>('PRAGMA quick_check');
    if(check.length!==1||check[0].quick_check!=='ok')throw Error('SQLite integrity check failed; preserve the database and investigate before sending');
    const wallets=await this.db.wallet.findMany({orderBy:{ordinal:'asc'}});
    if(wallets.length){
      if(wallets.length!==this.config.wallets.length||wallets.some((w,i)=>w.address!==this.config.wallets[i].address))throw Error('Wallet config differs from persisted pool; refusing to start');
      const state=await this.state();
      const bootstrap=state.teacherConfigAddress??state.teacherAddress;
      if(this.config.teacherAddress!==state.teacherAddress&&this.config.teacherAddress!==bootstrap)
        throw Error('Teacher config differs from both the bootstrap and the protected DB setting; use the saved config or the admin Change teacher action');
      await this.db.engineState.update({where:{id:1},data:{teacherConfigAddress:this.config.teacherAddress}});
      this.config.teacherAddress=state.teacherAddress;
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
        await tx.engineState.create({data:{id:1,teacherAddress:this.config.teacherAddress,teacherConfigAddress:this.config.teacherAddress,teacherBaseline:0,status:'Ready. Select at least two funded wallets, then Start.'}});
        await tx.audit.create({data:{event:'INITIALIZED',detail:`${this.config.wallets.length} wallets configured; mode ${MODE}`}});
      },{timeout:30_000});
    }
    let s=await this.state();
    if(this.campaignOnly&&s.phase==='MIXING'){
      await this.db.$transaction(async tx=>{
        await tx.transfer.updateMany({where:{kind:'MIX',campaignId:null,status:{in:['PLANNED','APPROVED','PAUSED']}},
          data:{status:'CANCELLED',note:'Upgrade paused the old amount modes; campaign requires a balanced baseline'}});
        await tx.engineState.update({where:{id:1},data:{phase:'LEGACY_PAUSED',lastPlanAt:null,
          status:'Old mixer paused for upgrade. Rebalance if necessary, select participants and start the complete smart plan.'}});
        await tx.audit.create({data:{event:'LEGACY_PAUSED',detail:'RANDOM/LIST stopped on upgrade; unsent approvals revoked; submitted transfers and all history retained'}});
      });
      s=await this.state();
    }
    if(s.phase==='MIXING')await this.trimLegacyMixQueue();
    if(['MIXING','LEGACY_PAUSED','REBALANCE_REQUESTED','REBALANCING','END_REQUESTED','SETTLING',...CAMPAIGN_PHASES].includes(s.phase))await this.withLock(()=>this.tickBody());
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
    const phase=this.campaignOnly&&recovery.phase==='MIXING'?'LEGACY_PAUSED':recovery.phase;
    await this.saveExtraReserves(recovery.extras,phase,recovery.haltReason??undefined);
    if(phase==='LEGACY_PAUSED')await this.db.transfer.updateMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},data:{status:'CANCELLED',note:'Legacy mixer paused after guarded recovery'}});
    await this.tickBody();
    return {ok:true,phase,reservedSun:recovery.totalExtraSun};
  });}
  async changeTeacher(address:string){return this.withLock(async()=>{
    if(!TronWeb.isAddress(address)||!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address))throw new HttpError(400,'Enter the full Base58Check TRON address');
    if(this.config.wallets.some(w=>w.address===address))throw new HttpError(400,'Teacher cannot be a participant wallet');
    const s=await this.state();
    if(address===s.teacherAddress)return {ok:true,teacherAddress:address};
    const [inFlight,unfinishedPayout]=await Promise.all([
      this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}}),
      this.db.transfer.findFirst({where:{kind:'PAYOUT',status:{notIn:['CONFIRMED','CANCELLED']}}})
    ]);
    const c=s.activeCampaignId?await this.db.campaign.findUnique({where:{id:s.activeCampaignId}}):null;
    if(inFlight||unfinishedPayout||['END_REQUESTED','SETTLING'].includes(s.phase)||c?.payAfterReturn)
      throw new HttpError(409,'Resolve in-flight transfers and finish or investigate the existing payout batch before changing the teacher');
    if(!await this.tron.active(address))throw new HttpError(409,'Teacher account must already be activated to avoid activation fees');
    await this.db.$transaction(async tx=>{
      await tx.engineState.update({where:{id:1},data:{teacherAddress:address}});
      await tx.audit.create({data:{event:'TEACHER_CHANGED',detail:`Admin changed teacher from ${s.teacherAddress} to ${address}; confirmed history retained; DB setting overrides the bootstrap config`}});
    });
    this.config.teacherAddress=address;
    return {ok:true,teacherAddress:address};
  });}

  private async assertPreparation(){
    const permission=await preparationPermission(this.db);
    if(!permission.canEdit)throw new HttpError(409,permission.reason!);
    return this.state();
  }
  private async archiveUnstarted(tx:Prisma.TransactionClient,s:EngineState){
    if(s.phase!=='CAMPAIGN'||!s.activeCampaignId)return;
    const c=await tx.campaign.findUniqueOrThrow({where:{id:s.activeCampaignId},include:{members:{orderBy:{ordinal:'asc'}}}});
    if(!c.planVariantId){
      const rows=await tx.transfer.findMany({where:{campaignId:c.id,status:{not:'CANCELLED'}},include:{allocations:true},orderBy:{sequence:'asc'}});
      const index=new Map(rows.map((t,i)=>[t.id,i]));
      const plan:CampaignPlan={seed:c.seed,totalDays:c.totalDays,mixingDays:c.mixingDays,
        profiles:c.members.map(m=>JSON.parse(m.profileJson)),steps:rows.map(t=>({kind:t.kind as 'MIX'|'RETURN',from:t.from,to:t.to,
          amountSun:t.amountSun,day:t.campaignDay!,plannedAt:t.plannedAt??t.scheduledAt,
          dependsIndex:t.dependsOnId?index.get(t.dependsOnId)??null:null,
          allocations:t.allocations.map(({ownerAddress,amountSun})=>({ownerAddress,amountSun}))}))};
      const v=await saveVariant(tx,c.members,plan,c.startedAt,c.deadlineAt,{sourceCampaignId:c.id,generatorVersion:c.version});
      await tx.campaign.update({where:{id:c.id},data:{planVariantId:v.id}});
    }
    await tx.transfer.updateMany({where:{campaignId:c.id,status:{in:['PLANNED','APPROVED','PAUSED']}},
      data:{status:'CANCELLED',note:'Returned to preparation before execution; prior approvals revoked; saved variant retained'}});
    await tx.campaign.update({where:{id:c.id},data:{status:'SUPERSEDED'}});
  }
  private checkDeadline(plan:CampaignPlan,deadlineAt:Date){
    if(!Number.isFinite(deadlineAt.getTime())||Math.max(...plan.steps.map(t=>t.plannedAt.getTime()))>deadlineAt.getTime()-4*DAY)
      throw new HttpError(400,'The complete plan must leave at least four days before the saved deadline. Shorten or regenerate the plan; the deadline is never extended automatically.');
  }
  async generatePlan(options:{totalDays?:number;deadlineAt?:Date}={}){return this.withLock(async()=>{
    const s=await this.assertPreparation();
    const selected=await this.db.wallet.findMany({where:{mixEnabled:true},orderBy:{ordinal:'asc'}});
    if(selected.length<2)throw new HttpError(409,'Select at least two funded wallets');
    const old=s.selectedPlanVariantId?await this.db.planVariant.findUnique({where:{id:s.selectedPlanVariantId}}):null;
    const c=s.activeCampaignId?await this.db.campaign.findUnique({where:{id:s.activeCampaignId}}):null;
    const totalDays=options.totalDays??old?.totalDays??c?.totalDays??36,anchorAt=new Date(Date.now()+2*60_000);
    if(!Number.isInteger(totalDays)||totalDays<18||totalDays>60)throw new HttpError(400,'Choose 18–60 campaign days');
    const deadlineAt=options.deadlineAt??old?.deadlineAt??c?.deadlineAt??new Date(anchorAt.getTime()+(totalDays+6)*DAY);
    let plan:CampaignPlan;
    try{plan=buildBalancedPlan(selected,randomBytes(16).toString('hex'),anchorAt,totalDays).plan;}
    catch(e){throw new HttpError(409,(e as Error).message);}
    this.checkDeadline(plan,deadlineAt);
    const variant=await this.db.$transaction(async tx=>{
      await this.archiveUnstarted(tx,s);
      const v=await saveVariant(tx,selected,plan,anchorAt,deadlineAt);
      await tx.engineState.update({where:{id:1},data:{phase:'PREPARING',activeCampaignId:null,selectedPlanVariantId:v.id,
        status:`Preparation: variant #${v.number} selected; compare or swap roles, then explicitly Start; nothing is sent`}});
      await tx.audit.create({data:{event:'PLAN_GENERATED',detail:`Saved variant #${v.number} ${v.id}; ${selected.length} members; deadline ${deadlineAt.toISOString()}; no transfers or approvals created`}});
      return v;
    },{timeout:60_000});
    return {ok:true,variantId:variant.id};
  });}
  async prepareCurrent(){return this.withLock(async()=>{
    const s=await this.assertPreparation();
    if(s.phase!=='CAMPAIGN'||!s.activeCampaignId)throw new HttpError(409,'No unstarted campaign to save');
    const v=await this.db.$transaction(async tx=>{
      await this.archiveUnstarted(tx,s);
      const c=await tx.campaign.findUniqueOrThrow({where:{id:s.activeCampaignId!}});
      const v=await tx.planVariant.findUniqueOrThrow({where:{id:c.planVariantId!}});
      await tx.engineState.update({where:{id:1},data:{phase:'PREPARING',activeCampaignId:null,selectedPlanVariantId:v.id,
        status:`Preparation: current plan saved as variant #${v.number}; prior approvals revoked; Start required`}});
      await tx.audit.create({data:{event:'PLAN_PREPARED',detail:`Campaign ${c.id} retained as variant #${v.number}; no execution; approvals revoked`}});
      return v;
    },{timeout:60_000});
    return {ok:true,variantId:v.id};
  });}
  async selectPlan(id:string){return this.withLock(async()=>{
    const s=await this.assertPreparation(),v=await this.db.planVariant.findUnique({where:{id}});
    if(!v)throw new HttpError(404,'Saved plan not found');
    const {members,plan}=loadVariant(v,new Date(Date.now()+2*60_000));
    if(members.some(m=>!this.config.wallets.some(w=>w.address===m.address)))throw new HttpError(409,'Saved plan members differ from configured wallets');
    this.checkDeadline(plan,v.deadlineAt);
    await this.db.$transaction(async tx=>{
      await this.archiveUnstarted(tx,s);
      await tx.wallet.updateMany({data:{mixEnabled:false}});
      await tx.wallet.updateMany({where:{address:{in:members.map(m=>m.address)}},data:{mixEnabled:true}});
      await tx.engineState.update({where:{id:1},data:{phase:'PREPARING',activeCampaignId:null,selectedPlanVariantId:v.id,
        status:`Preparation: saved variant #${v.number} selected; Start required`}});
      await tx.audit.create({data:{event:'PLAN_SELECTED',detail:`Variant #${v.number} ${v.id}; cohort restored; nothing is sent until Start`}});
    },{timeout:60_000});
    return {ok:true,variantId:v.id};
  });}
  async swapPlans(id:string,a:string,b:string){return this.withLock(async()=>{
    const s=await this.assertPreparation(),v=await this.db.planVariant.findUnique({where:{id}});
    if(!v)throw new HttpError(404,'Saved plan not found');
    const {members,plan}=loadVariant(v);
    let swapped:CampaignPlan;try{swapped=swapPlan(members,plan,a,b);}catch(e){throw new HttpError(400,(e as Error).message);}
    const rebased=loadVariant({...v,planJson:serializePlan(swapped,v.anchorAt)},new Date(Date.now()+2*60_000));
    this.checkDeadline(rebased.plan,v.deadlineAt);
    const next=await this.db.$transaction(async tx=>{
      await this.archiveUnstarted(tx,s);
      const next=await saveVariant(tx,members,swapped,v.anchorAt,v.deadlineAt,{parentId:v.id,generatorVersion:v.generatorVersion});
      await tx.wallet.updateMany({data:{mixEnabled:false}});
      await tx.wallet.updateMany({where:{address:{in:members.map(m=>m.address)}},data:{mixEnabled:true}});
      await tx.engineState.update({where:{id:1},data:{phase:'PREPARING',activeCampaignId:null,selectedPlanVariantId:next.id,
        status:`Preparation: swapped roles ${a} and ${b}; saved variant #${next.number}; Start required`}});
      await tx.audit.create({data:{event:'PLAN_SWAPPED',detail:`Variant #${v.number} → #${next.number}; ${a} ↔ ${b}; routes, owners and profiles permuted together; original preserved`}});
      return next;
    },{timeout:60_000});
    return {ok:true,variantId:next.id};
  });}
  async startCampaign(options:{totalDays?:number;deadlineAt?:Date}={}){return this.withLock(async()=>{
    const s=await this.state();
    if(!['IDLE','MIXING','LEGACY_PAUSED','CAMPAIGN_RESTORED','PREPARING'].includes(s.phase))throw new HttpError(409,`Cannot create a new campaign in ${s.phase}`);
    if(await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}}))
      throw new HttpError(409,'Wait for the submitted transaction to confirm before creating a campaign');
    if(await this.db.transfer.count({where:{kind:'PAYOUT',status:'CONFIRMED'}}))throw new HttpError(409,'This pool has already paid stakes');
    const previouslyJoined=await this.joined();
    if(previouslyJoined.length){
      const balances=await this.reconcile();if(!balances)throw new HttpError(409,'Pool verification failed');
      const current=await this.joined();
      if(balances.some(w=>w.sun!==current.find(j=>j.address===w.address)!.entryBalanceSun!))
        throw new HttpError(409,'Rebalance the old game first: every joined wallet must hold exactly 1 TRX plus its protected extra Sun');
    }
    const selected=await this.db.wallet.findMany({where:{mixEnabled:true},orderBy:{ordinal:'asc'}});
    if(selected.length<2)throw new HttpError(409,'Select at least two funded wallets');
    const balances=await this.balances(selected);
    for(const w of selected){
      if(!await this.tron.active(w.address))throw new HttpError(409,`Node ${w.ordinal+1} is not activated`);
      const balance=balances.find(b=>b.address===w.address)!.sun;
      if(balance<TARGET||w.joined&&balance!==w.entryBalanceSun)
        throw new HttpError(409,`Node ${w.ordinal+1} must hold 1 TRX plus its recorded personal reserve`);
    }
    const startedAt=new Date(Date.now()+2*60_000);
    const saved=s.selectedPlanVariantId?await this.db.planVariant.findUnique({where:{id:s.selectedPlanVariantId}}):null;
    if(s.phase==='PREPARING'&&!saved)throw new HttpError(409,'Generate or choose a saved plan before Start');
    const totalDays=saved?.totalDays??options.totalDays??36;
    const deadlineAt=saved?.deadlineAt??options.deadlineAt??new Date(startedAt.getTime()+(totalDays+6)*DAY);
    let plan:CampaignPlan;
    if(saved){
      const loaded=loadVariant(saved,startedAt);
      if(JSON.stringify(loaded.members.map(m=>m.address))!==JSON.stringify(selected.map(m=>m.address)))throw new HttpError(409,'Selected wallets differ from the saved plan; regenerate or select that variant again');
      plan=loaded.plan;
    }else{
      if(!Number.isInteger(totalDays)||totalDays<18||totalDays>60)throw new HttpError(400,'Choose 18–60 campaign days');
      try{plan=buildBalancedPlan(selected,randomBytes(16).toString('hex'),startedAt,totalDays).plan;}
      catch(e){throw new HttpError(409,(e as Error).message);}
    }
    this.checkDeadline(plan,deadlineAt);
    const id=randomUUID(),stepIds=plan.steps.map(()=>randomUUID());
    const chosen=plan;
    await this.db.$transaction(async tx=>{
      await tx.transfer.updateMany({where:{kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},
        data:{status:'CANCELLED',note:'Superseded by the attributed campaign; old approvals revoked'}});
      for(const w of selected)if(!w.joined){
        const balance=balances.find(b=>b.address===w.address)!.sun;
        await tx.wallet.update({where:{address:w.address},data:{joined:true,entryBalanceSun:balance}});
        await tx.audit.create({data:{event:'JOIN',detail:`${w.address} joined with 1 TRX; ${balance-TARGET} extra Sun reserved`}});
      }
      const variant=saved??await saveVariant(tx,selected,chosen,startedAt,deadlineAt);
      await tx.campaign.create({data:{id,planVariantId:variant.id,version:variant.generatorVersion,seed:chosen.seed,startedAt,deadlineAt,totalDays,mixingDays:chosen.mixingDays}});
      await tx.campaignMember.createMany({data:selected.map((w,i)=>({campaignId:id,address:w.address,ordinal:w.ordinal,profileJson:JSON.stringify(chosen.profiles[i])}))});
      await tx.ownershipBalance.createMany({data:selected.map(w=>({campaignId:id,ownerAddress:w.address,holderAddress:w.address,amountSun:TARGET}))});
      await tx.transfer.createMany({data:chosen.steps.map((step,i)=>({id:stepIds[i],sequence:s.nextSequence+i,kind:step.kind,
        status:selected.find(w=>w.address===step.from)!.autoApprove?'APPROVED':'PLANNED',
        approvalSource:selected.find(w=>w.address===step.from)!.autoApprove?'AUTO':null,
        from:step.from,to:step.to,amountSun:step.amountSun,scheduledAt:step.plannedAt,plannedAt:step.plannedAt,
        campaignId:id,campaignDay:step.day,dependsOnId:step.dependsIndex===null?null:stepIds[step.dependsIndex]}))});
      await tx.allocation.createMany({data:chosen.steps.flatMap((step,i)=>step.allocations.map(a=>({...a,transferId:stepIds[i]})))});
      await tx.engineState.update({where:{id:1},data:{phase:'CAMPAIGN',activeCampaignId:id,selectedPlanVariantId:variant.id,nextSequence:s.nextSequence+chosen.steps.length,
        mixAmountMode:'SMART',lastPlanAt:null,fatalReason:null,haltedFromPhase:null,
        status:`Campaign planned: ${chosen.steps.length} transfers; ${chosen.mixingDays} equal mixing sends per wallet; manual approval unless Auto is enabled`}});
      await tx.audit.create({data:{event:'CAMPAIGN_PLANNED',detail:`Campaign ${id}; ${selected.length} members; ${chosen.mixingDays} mixing rounds; staggered split profiles; ${chosen.steps.length} native transfers; deadline ${deadlineAt.toISOString()}; old unsent approvals cancelled`}});
    },{timeout:60_000});
    this.tron.invalidatePublicSnapshot();
    return {ok:true,campaignId:id,totalTransfers:chosen.steps.length};
  });}

  private async requestCampaignReturn(reason:string,payAfterReturn=false){
    const s=await this.state();if(!s.activeCampaignId)throw new HttpError(409,'No attributed campaign');
    if(!CAMPAIGN_PHASES.includes(s.phase))throw new HttpError(409,`Cannot return campaign funds in ${s.phase}`);
    const campaign=await this.db.campaign.findUniqueOrThrow({where:{id:s.activeCampaignId}});
    if(campaign.payAfterReturn&&!payAfterReturn)
      throw new HttpError(409,'End Game was already explicitly requested; the existing payout batch must be resolved first');
    // Retried Rebalance requests must reuse the saved closing map and its
    // approvals. End is the only action allowed to upgrade it to payouts.
    if(!payAfterReturn&&(s.phase==='CAMPAIGN_RESTORED'||
      ['CAMPAIGN_RETURN_REQUESTED','CAMPAIGN_RETURNING'].includes(s.phase)&&
      campaign.returnReason!=='Scheduled complete-plan return'))return;
    if(await this.db.transfer.findFirst({where:{status:'UNKNOWN'}}))throw new HttpError(409,'Investigate the uncertain transaction before changing the closing map');
    await this.db.$transaction(async tx=>{
      await tx.transfer.updateMany({where:{campaignId:s.activeCampaignId,kind:{in:['MIX','RETURN']},status:{in:['PLANNED','APPROVED','PAUSED']}},
        data:{status:'CANCELLED',note:`Campaign closing requested: ${reason}; unsent approval revoked`}});
      await tx.campaign.update({where:{id:s.activeCampaignId!},data:{status:'RETURN_REQUESTED',returnReason:reason,payAfterReturn}});
      await tx.engineState.update({where:{id:1},data:{phase:'CAMPAIGN_RETURN_REQUESTED',status:'Closing requested; confirming any submitted transfer before returning attributed shares'}});
      await tx.audit.create({data:{event:'CAMPAIGN_RETURN_REQUESTED',detail:`${reason}; teacher payouts ${payAfterReturn?'requested after restoration':'not requested'}; original confirmed history preserved`}});
    });
  }
  async returnCampaign(){return this.withLock(async()=>{
    await this.requestCampaignReturn('Admin requested early return to original owners');
    await this.tickBody();return {ok:true};
  });}
  async campaignReturnPreview(){return this.withLock(async()=>{
    const s=await this.state();if(!s.activeCampaignId)throw new HttpError(409,'No attributed campaign');
    const pending=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}});
    if(pending)return {pendingReceipt:true,transferCount:null,steps:[],estimatedDays:null};
    const positions=await verifyOwnership(this.db,s.activeCampaignId);
    const steps=attributedReturns(positions),counts=new Map<string,number>();
    for(const step of steps)counts.set(step.from,(counts.get(step.from)??0)+1);
    return {pendingReceipt:false,transferCount:steps.length,steps,estimatedDays:Math.max(0,...counts.values())};
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
  private async insert(rows:{kind:string;status:string;from:string;to:string;amountSun:number;scheduledAt:Date;note?:string;
    campaignId?:string;campaignDay?:number;plannedAt?:Date;allocations?:{ownerAddress:string;amountSun:number}[]}[],
    transition:{status:string;phase?:string;lastPlanAt?:Date;event:string;detail:string}){
    const s=await this.state();
    const wallets=await this.db.wallet.findMany();const auto=new Map(wallets.map(w=>[w.address,w.autoApprove]));
    await this.db.$transaction(async tx=>{
      for(let i=0;i<rows.length;i++){
        const {allocations,...r}=rows[i];const status=auto.get(r.from)?'APPROVED':'PLANNED';
        const t=await tx.transfer.create({data:{...r,status,approvalSource:auto.get(r.from)?'AUTO':null,sequence:s.nextSequence+i,
          ...(allocations?{allocations:{create:allocations}}:{})}});
        await tx.audit.create({data:{event:'QUEUED',detail:`${r.kind} ${r.amountSun} Sun ${r.from} → ${r.to}; ${status}`,transferId:t.id}});
      }
      await tx.engineState.update({where:{id:1},data:{nextSequence:s.nextSequence+rows.length,status:transition.status,
        ...(transition.phase?{phase:transition.phase}:{}),...(transition.lastPlanAt?{lastPlanAt:transition.lastPlanAt}:{})}});
      await tx.audit.create({data:{event:transition.event,detail:transition.detail}});
    },{timeout:30_000});
  }
  async end(){return this.withLock(async()=>{
    const s=await this.state();
    if(CAMPAIGN_PHASES.includes(s.phase)){
      const campaign=await this.db.campaign.findUniqueOrThrow({where:{id:s.activeCampaignId!}});
      if(campaign.payAfterReturn)return {ok:true};
      await this.requestCampaignReturn('Admin requested End: return attributed stakes, then pay exactly 1 TRX each',true);
      await this.tickBody();return {ok:true};
    }
    if(s.phase==='END_REQUESTED'||s.phase==='SETTLING')return {ok:true};
    if(!['MIXING','LEGACY_PAUSED','REBALANCE_REQUESTED','REBALANCING'].includes(s.phase))throw new HttpError(409,`Cannot end in ${s.phase}`);
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
    if(!['MIXING','LEGACY_PAUSED'].includes(s.phase))throw new HttpError(409,`Cannot preview rebalance in ${s.phase}`);
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
    if(CAMPAIGN_PHASES.includes(s.phase)){
      await this.requestCampaignReturn('Admin requested attributed rebalance; campaign stops after restoration');
      await this.tickBody();return {ok:true};
    }
    if(['REBALANCE_REQUESTED','REBALANCING'].includes(s.phase))return {ok:true};
    if(!['MIXING','LEGACY_PAUSED'].includes(s.phase))throw new HttpError(409,`Cannot rebalance in ${s.phase}`);
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
    const state=await this.state();
    const campaign=state.activeCampaignId?await this.db.campaign.findUnique({where:{id:state.activeCampaignId},include:{members:true}}):null;
    const members=campaign?.members??[];
    const rows=steps.map(x=>({...x,status:'PLANNED',scheduledAt:now,...(x.kind==='PAYOUT'&&members.some(m=>m.address===x.from)?{
      campaignId:state.activeCampaignId!,campaignDay:Math.max(1,Math.floor((now.getTime()-campaign!.startedAt.getTime())/DAY)+1),plannedAt:now,
      allocations:[{ownerAddress:x.from,amountSun:TARGET}]}:{})}));
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
    if(!['IDLE','MIXING','LEGACY_PAUSED','CAMPAIGN_RESTORED','PREPARING'].includes(s.phase))throw new HttpError(409,`Campaign participants are fixed until restoration; cannot change them in ${s.phase}`);
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
        await tx.engineState.update({where:{id:1},data:{selectedPlanVariantId:null,status:'Selection changed. Generate or select a complete plan before Start.'}});
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
    const s=await this.state();if(['HALTED','COMPLETE','PREPARING'].includes(s.phase))throw new HttpError(409,'Engine is halted or complete');
    const t=await this.db.transfer.findUnique({where:{id}});
    if(!t||t.status!=='PLANNED')throw new HttpError(409,'Transfer is no longer awaiting approval');
    await this.db.transfer.update({where:{id},data:{status:'APPROVED',approvalSource:'MANUAL'}});
    await this.audit('APPROVED',`Manual approval: ${t.kind} ${t.amountSun} Sun ${t.from} → ${t.to}`,id);
    await this.tickBody();return {ok:true};
  });}
  async autoApprove(address:string,enabled:boolean){return this.withLock(async()=>{
    const wallet=await this.db.wallet.findUnique({where:{address}});if(!wallet)throw new HttpError(404,'Wallet not found');
    await this.db.$transaction(async tx=>{
      await tx.wallet.update({where:{address},data:{autoApprove:enabled}});
      if(enabled)await tx.transfer.updateMany({where:{from:address,status:'PLANNED'},data:{status:'APPROVED',approvalSource:'AUTO'}});
      else await tx.transfer.updateMany({where:{from:address,status:'APPROVED',approvalSource:'AUTO'},data:{status:'PLANNED',approvalSource:null}});
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
          const c=t.campaignId&&t.kind==='MIX'?await this.db.campaign.findUnique({where:{id:t.campaignId},select:{timingMode:true}}):null;
          const policy=c?.timingMode==='BANDWIDTH'?{minimum:ADAPTIVE_BANDWIDTH,bufferMs:0}:undefined;
          const retried=await this.tron.rebroadcastPersisted(t.from,t.to,t.amountSun,t.txId!,t.signedJson,policy);
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
      const committed=await tx.transfer.updateMany({where:{id:t.id,status:{in:['SUBMITTING','SUBMITTED']}},data:{status:'CONFIRMED',signedJson:null,bandwidthUsed:r.bandwidthUsed,confirmedAt:r.confirmedAt,note:`Confirmed: fee 0 Sun; ${r.bandwidthUsed===null?'Bandwidth not reported by node':`${r.bandwidthUsed} Bandwidth used`}`}});
      if(committed.count!==1)return; // duplicate receipt polling cannot debit ownership twice
      await applyConfirmedOwnership(tx,t);
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
  async accelerateCampaign(){return this.withLock(async()=>{
    const s=await this.state();
    if(s.phase!=='CAMPAIGN'||!s.activeCampaignId)throw new HttpError(409,'Acceleration requires an active mixing campaign');
    const c=await this.db.campaign.findUniqueOrThrow({where:{id:s.activeCampaignId}});
    if(c.timingMode==='BANDWIDTH')return {ok:true,timingMode:c.timingMode,alreadyEnabled:true};
    const flight=await this.db.transfer.findFirst({where:{campaignId:c.id,status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}}});
    if(flight?.status==='UNKNOWN')throw new HttpError(409,'Resolve the ambiguous transaction before changing timing');
    if(flight){
      await this.db.$transaction(async tx=>{
        await tx.campaign.update({where:{id:c.id},data:{timingMode:'BANDWIDTH'}});
        await tx.audit.create({data:{event:'CAMPAIGN_TIMING_ENABLED',detail:`Campaign ${c.id}: resource-based MIX timing enabled; frozen routes, allocations and approvals retained; waiting for persisted tx ${flight.txId}`}});
      });
      this.timingRevision='';return {ok:true,timingMode:'BANDWIDTH',pendingReceipt:true};
    }
    await this.refreshAdaptiveTimeline(c,undefined,true);
    await this.tickBody();
    return {ok:true,timingMode:'BANDWIDTH',pendingReceipt:false};
  });}
  private async refreshAdaptiveTimeline(c:{id:string;startedAt:Date},observed?:{address:string;snapshot:BandwidthSnapshot},enable=false){
    const [pending,closing,previous]=await Promise.all([
      this.db.transfer.findMany({where:{campaignId:c.id,kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},orderBy:{sequence:'asc'}}),
      this.db.transfer.findMany({where:{campaignId:c.id,kind:'RETURN',status:{in:['PLANNED','APPROVED','PAUSED']}},orderBy:{sequence:'asc'}}),
      this.db.transfer.findFirst({where:{status:'CONFIRMED'},orderBy:{sequence:'desc'},select:{id:true,confirmedAt:true,updatedAt:true}})
    ]);
    if(!pending.length){if(enable)throw new HttpError(409,'There are no remaining MIX transfers');return;}
    if(pending.some(t=>t.txId!==null||t.signedJson!==null))throw new OwnershipError('A pending MIX has a persisted signature; resolve its original transaction before rescheduling');
    const wallets=new Map<string,TimingWallet>();
    await Promise.all([...new Set(pending.map(t=>t.from))].map(async address=>{
      // Rechecking a blocked head only needs that sender's fresh resource
      // observation. Other snapshots are forecast inputs, never permission to
      // send; refresh all senders after a receipt, activation or restart.
      const cached=observed&&this.timingResources?.campaignId===c.id?this.timingResources.wallets.get(address):undefined;
      if(cached&&observed&&observed.address!==address){wallets.set(address,cached);return;}
      const [snapshot,spends,last]=await Promise.all([
        observed?.address===address?Promise.resolve(observed.snapshot):this.tron.bandwidthSnapshot(address),
        this.tron.recentBandwidthSpends(address),
        this.db.transfer.findFirst({where:{from:address,status:'CONFIRMED'},orderBy:{sequence:'desc'},select:{bandwidthUsed:true,confirmedAt:true,updatedAt:true}})
      ]);
      if(snapshot.limit<ADAPTIVE_BANDWIDTH)throw new HttpError(400,`Wallet ${address} has a free quota below ${ADAPTIVE_BANDWIDTH}`);
      const known=last?.bandwidthUsed;
      wallets.set(address,{snapshot,spends,cost:known&&known>0?Math.min(snapshot.limit,known):400,
        lastConfirmedAt:last?(last.confirmedAt??last.updatedAt).getTime():null});
    }));
    const now=Date.now(),previousAt=previous?(previous.confirmedAt??previous.updatedAt).getTime():c.startedAt.getTime();
    const forecast=adaptiveMixForecast(pending,wallets,now,previousAt,previous?.id??null);
    const returns=adaptiveReturnForecast(closing,forecast.mixEndsAt,forecast.lastSenderAt,now);
    await this.db.$transaction(async tx=>{
      for(const slot of forecast.times){
        const old=pending.find(t=>t.id===slot.id)!;
        if(old.scheduledAt.getTime()===slot.scheduledAt.getTime()&&old.pacingDelayMs===slot.pacingDelayMs&&old.pacingAfterId===slot.pacingAfterId)continue;
        await tx.transfer.updateMany({where:{id:slot.id,txId:null,status:{in:['PLANNED','APPROVED','PAUSED']}},data:{
          scheduledAt:slot.scheduledAt,pacingDelayMs:slot.pacingDelayMs,pacingAfterId:slot.pacingAfterId}});
      }
      for(const slot of returns){
        if(closing.find(t=>t.id===slot.id)!.scheduledAt.getTime()===slot.scheduledAt.getTime())continue;
        await tx.transfer.updateMany({where:{id:slot.id,txId:null,status:{in:['PLANNED','APPROVED','PAUSED']}},data:{scheduledAt:slot.scheduledAt}});
      }
      await tx.campaign.update({where:{id:c.id},data:{timingUpdatedAt:new Date(now),...(enable?{timingMode:'BANDWIDTH'}:{})}});
      if(enable)await tx.audit.create({data:{event:'CAMPAIGN_TIMING_ENABLED',detail:`Campaign ${c.id}: remaining MIX times recalculated in original sequence; ${ADAPTIVE_BANDWIDTH} free Bandwidth floor, no hourly buffer; saved random gaps; routes, amounts, allocations, original plannedAt and approvals retained; return ends in pause without teacher payouts`}});
    },{timeout:30_000});
    this.timingResources={campaignId:c.id,wallets};
    this.timingRevision=`${c.id}:${pending[0].id}:${previous?.id??'start'}`;
  }
  private async waitForAdaptiveResource(next:Transfer,snapshot:BandwidthSnapshot,required:number){
    const spends=await this.tron.recentBandwidthSpends(next.from),now=Date.now();
    const estimated=bufferedReadyAt(snapshot.limit,snapshot.available,snapshot.observedAt,now,required,spends,0);
    const checkAt=new Date(Math.max(now+15_000,Math.min(estimated??now+RESOURCE_PROBE_MS,now+RESOURCE_PROBE_MS)));
    await this.db.transfer.update({where:{id:next.id},data:{resourceReadyAt:null,resourceCheckAt:checkAt,resourceRequired:required,
      note:`Waiting for free Bandwidth: ${snapshot.available}/${required}; live check ${checkAt.toISOString()}`}});
    const c=await this.db.campaign.findUniqueOrThrow({where:{id:next.campaignId!}});
    try{await this.refreshAdaptiveTimeline(c,{address:next.from,snapshot});}
    catch(e){if(e instanceof OwnershipError)throw e;this.timingRevision='';console.error('Adaptive forecast:',e instanceof Error?e.message:String(e));}
    this.wake(checkAt);
    await this.db.engineState.update({where:{id:1},data:{status:`Waiting for free Bandwidth: ${next.from}, ${snapshot.available}/${required}; next live check ${checkAt.toISOString()}; later MIX transfers stay behind this step`}});
  }
  private async adaptivePacing(next:Transfer){
    let snapshot:BandwidthSnapshot;
    try{snapshot=await this.tron.bandwidthSnapshot(next.from);}
    catch(e){
      const retryAt=new Date(Date.now()+60_000);
      await this.db.transfer.update({where:{id:next.id},data:{resourceCheckAt:retryAt}});
      await this.db.engineState.update({where:{id:1},data:{status:`Resource node unavailable for MIX #${next.sequence}; waiting for a fresh quota check`}});
      this.wake(retryAt);return true;
    }
    const required=Math.max(ADAPTIVE_BANDWIDTH,next.resourceRequired??0);
    if(snapshot.available<required){await this.waitForAdaptiveResource(next,snapshot,required);return true;}
    let readyAt=next.resourceReadyAt,delay=next.pacingDelayMs;
    if(!readyAt){
      readyAt=new Date(Date.now());
      const [min,max]=gapRange(snapshot.available>=snapshot.limit);
      if(delay===null||delay<min||delay>max)delay=chooseGap(snapshot.available>=snapshot.limit);
      await this.db.transfer.update({where:{id:next.id},data:{resourceReadyAt:readyAt,resourceCheckAt:null,pacingDelayMs:delay,
        note:'Live free quota ready; saved random interval before the next ordered MIX transfer'}});
      const c=await this.db.campaign.findUniqueOrThrow({where:{id:next.campaignId!}});
      try{await this.refreshAdaptiveTimeline(c,{address:next.from,snapshot});}
      catch(e){
        if(e instanceof OwnershipError)throw e;
        this.timingRevision='';
        await this.db.transfer.update({where:{id:next.id},data:{scheduledAt:new Date(readyAt.getTime()+delay!)}});
        console.error('Adaptive forecast:',e instanceof Error?e.message:String(e));
      }
    }
    const until=new Date(readyAt.getTime()+delay!);
    if(until.getTime()>Date.now()){
      this.wake(until);
      await this.db.engineState.update({where:{id:1},data:{status:`Saved random interval before MIX #${next.sequence}: ${until.toISOString()}; approval and live resource checks required`}});
      return true;
    }
    return false;
  }
  private async createCampaignReturnMap(s:EngineState){
    const c=await this.db.campaign.findUniqueOrThrow({where:{id:s.activeCampaignId!},include:{members:true}});
    const positions=await verifyOwnership(this.db,c.id),steps=attributedReturns(positions),wallets=await this.joined();
    const ready=new Map<string,number>();
    for(const from of new Set(steps.map(t=>t.from))){
      const snapshot=await this.tron.bandwidthSnapshot(from);
      const last=await this.db.transfer.findFirst({where:{from,status:'CONFIRMED'},orderBy:{sequence:'desc'}});
      const earliest=last?Math.max(Date.now(),(last.confirmedAt??last.updatedAt).getTime()+DAY):Date.now();
      ready.set(from,bufferedReadyAt(snapshot.limit,snapshot.available,snapshot.observedAt,earliest,MIN_FREE_BANDWIDTH,
        await this.tron.recentBandwidthSpends(from))??Date.now()+DAY);
    }
    const counts=new Map<string,number>();
    const planned=steps.map(t=>{const index=counts.get(t.from)??0;counts.set(t.from,index+1);
      return {...t,scheduledAt:new Date(ready.get(t.from)!+index*DAY)};}).sort((a,b)=>a.scheduledAt.getTime()-b.scheduledAt.getTime());
    const ids=planned.map(()=>randomUUID()),previous=new Map<string,string>();
    await this.db.$transaction(async tx=>{
      for(let i=0;i<planned.length;i++){
        const {allocations,...t}=planned[i],auto=wallets.find(w=>w.address===t.from)!.autoApprove;
        await tx.transfer.create({data:{...t,id:ids[i],campaignId:c.id,campaignDay:Math.max(1,Math.floor((t.scheduledAt.getTime()-c.startedAt.getTime())/DAY)+1),
          plannedAt:t.scheduledAt,sequence:s.nextSequence+i,status:auto?'APPROVED':'PLANNED',approvalSource:auto?'AUTO':null,
          dependsOnId:previous.get(t.from)??null,allocations:{create:allocations}}});
        previous.set(t.from,ids[i]);
      }
      const payoutSequence=s.nextSequence+planned.length;
      if(c.payAfterReturn){
        for(let i=0;i<wallets.length;i++){
          const w=wallets[i],owned=c.members.some(m=>m.address===w.address),at=new Date(Math.max(Date.now(),...planned.map(p=>p.scheduledAt.getTime()))+DAY);
          await tx.transfer.create({data:{sequence:payoutSequence+i,kind:'PAYOUT',from:w.address,to:s.teacherAddress,amountSun:TARGET,
            scheduledAt:at,plannedAt:at,status:w.autoApprove?'APPROVED':'PLANNED',approvalSource:w.autoApprove?'AUTO':null,
            ...(owned?{campaignId:c.id,campaignDay:Math.max(1,Math.floor((at.getTime()-c.startedAt.getTime())/DAY)+1),
              allocations:{create:[{ownerAddress:w.address,amountSun:TARGET}]}}:{})}});
        }
      }
      await tx.campaign.update({where:{id:c.id},data:{status:'RETURNING'}});
      await tx.engineState.update({where:{id:1},data:{phase:'CAMPAIGN_RETURNING',
        nextSequence:payoutSequence+(c.payAfterReturn?wallets.length:0),settlementFromSequence:c.payAfterReturn?payoutSequence:null,
        status:`Return map ready: ${planned.length} attributed transfers${c.payAfterReturn?` and ${wallets.length} exact teacher payouts`:''}; approvals and live Bandwidth checks required`}});
      await tx.audit.create({data:{event:'CAMPAIGN_RETURN_MAP',detail:`${planned.length} direct transfers return original attributed stakes; ${c.returnReason??'scheduled closure'}; teacher payouts ${c.payAfterReturn?'included':'excluded'}`}});
    },{timeout:60_000});
  }
  private async tickCampaign(s:EngineState,b:PoolBalance[]){
    const c=await this.db.campaign.findUniqueOrThrow({where:{id:s.activeCampaignId!},include:{members:true}});
    if(s.phase==='CAMPAIGN_RESTORED')return;
    if(s.phase==='CAMPAIGN_RETURN_REQUESTED'){await this.createCampaignReturnMap(s);s=await this.state();}
    if(s.phase==='CAMPAIGN'){
      if(c.timingMode==='BANDWIDTH'){
        const [head,previous]=await Promise.all([
          this.db.transfer.findFirst({where:{campaignId:c.id,kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},orderBy:{sequence:'asc'},select:{id:true}}),
          this.db.transfer.findFirst({where:{status:'CONFIRMED'},orderBy:{sequence:'desc'},select:{id:true}})
        ]);
        if(head&&this.timingRevision!==`${c.id}:${head.id}:${previous?.id??'start'}`){
          try{await this.refreshAdaptiveTimeline(c);}
          catch(e){
            if(e instanceof OwnershipError)throw e;
            await this.db.engineState.update({where:{id:1},data:{status:'Waiting for resource observations to refresh the ordered MIX schedule'}});
            console.error('Adaptive forecast:',e instanceof Error?e.message:String(e));
            this.wake(new Date(Date.now()+60_000));return;
          }
        }
      }
      const mix=await this.db.transfer.findFirst({where:{campaignId:c.id,kind:'MIX',status:{in:['PLANNED','APPROVED','PAUSED']}},orderBy:{sequence:'asc'}});
      if(!mix){
        await this.db.$transaction(async tx=>{
          await tx.campaign.update({where:{id:c.id},data:{status:'RETURNING',returnReason:'Scheduled complete-plan return'}});
          await tx.engineState.update({where:{id:1},data:{phase:'CAMPAIGN_RETURNING',status:'Mixing complete; returning every attributed stake to its owner'}});
          await tx.audit.create({data:{event:'CAMPAIGN_MIX_COMPLETE',detail:'All planned mixing rounds confirmed; using the persisted closing map'}});
        });
        s=await this.state();
      }else{
        const positions=await this.db.ownershipBalance.findMany({where:{campaignId:c.id}}),returns=attributedReturns(positions);
        const perSender=new Map<string,number>();for(const r of returns)perSender.set(r.from,(perSender.get(r.from)??0)+1);
        const final=await this.db.transfer.findFirst({where:{campaignId:c.id,kind:'RETURN',status:{in:['PLANNED','APPROVED','PAUSED']}},orderBy:{scheduledAt:'desc'}});
        // Stop expanding routes while enough time remains to return the
        // currently attributed funds. Manual mode still needs approvals.
        const returnBudget=Math.max(1,...perSender.values())*DAY;
        if(Date.now()+returnBudget+4*DAY>=c.deadlineAt.getTime()||final&&final.scheduledAt.getTime()>c.deadlineAt.getTime()-4*DAY){
          await this.requestCampaignReturn('Deadline guard: preserving time for attributed returns and payouts');
          await this.createCampaignReturnMap(await this.state());return;
        }
      }
    }
    const kind=s.phase==='CAMPAIGN'?'MIX':'RETURN';
    const candidates=await this.db.transfer.findMany({where:{campaignId:c.id,kind,status:{in:['PLANNED','APPROVED','PAUSED']}},
      orderBy:kind==='MIX'?{sequence:'asc'}:[{scheduledAt:'asc'},{sequence:'asc'}],include:{allocations:true}});
    let next=candidates[0];
    if(kind==='RETURN'){
      // Returns to different owners/senders are independent. A low-resource
      // wallet must not block ready returns from all other wallets.
      const heads=new Map<string,typeof next>();
      for(const row of candidates)if(!heads.has(row.from)||row.sequence<heads.get(row.from)!.sequence)heads.set(row.from,row);
      const pending=[...heads.values()].sort((a,b)=>a.scheduledAt.getTime()-b.scheduledAt.getTime());
      next=pending.find(t=>t.status==='APPROVED'&&t.scheduledAt.getTime()<=Date.now())??pending[0];
    }
    if(!next){
      const positions=await verifyOwnership(this.db,c.id);
      if(c.members.some(m=>positions.filter(p=>p.ownerAddress===m.address).reduce((n,p)=>n+p.amountSun,0)!==TARGET||
        positions.some(p=>p.ownerAddress===m.address&&p.holderAddress!==m.address)))throw new OwnershipError('Closing queue ended before returning every original 1 TRX');
      await this.db.$transaction(async tx=>{
        await tx.campaign.update({where:{id:c.id},data:{status:'RESTORED'}});
        await tx.engineState.update({where:{id:1},data:{phase:c.payAfterReturn?'SETTLING':'CAMPAIGN_RESTORED',
          status:c.payAfterReturn?'Original stakes restored; teacher payout map awaiting execution':'Campaign restored: every original 1 TRX is back; mixing stopped; reports and history retained'}});
        await tx.audit.create({data:{event:'CAMPAIGN_RESTORED',detail:'Every original attributed stake returned to its owner; personal extra Sun remains outside the game'}});
      });return;
    }
    if(next.dependsOnId){
      const predecessor=await this.db.transfer.findUniqueOrThrow({where:{id:next.dependsOnId}});
      if(predecessor.status!=='CONFIRMED'){
        await this.db.engineState.update({where:{id:1},data:{status:`Waiting for confirmed predecessor #${predecessor.sequence} before #${next.sequence}`}});return;
      }
    }
    if(next.status==='PLANNED'){
      await this.db.engineState.update({where:{id:1},data:{status:`Awaiting approval: day ${next.campaignDay}, ${next.kind} #${next.sequence}`}});return;
    }
    const adaptive=kind==='MIX'&&c.timingMode==='BANDWIDTH';
    if(adaptive&&next.status!=='APPROVED'){
      await this.db.engineState.update({where:{id:1},data:{status:`MIX #${next.sequence} is ${next.status}; later transfers cannot overtake it`}});return;
    }
    if(adaptive&&next.resourceCheckAt&&next.resourceCheckAt.getTime()>Date.now()){
      this.wake(next.resourceCheckAt);
      await this.db.engineState.update({where:{id:1},data:{status:`Waiting for the next live resource check for MIX #${next.sequence}: ${next.resourceCheckAt.toISOString()}`}});return;
    }
    if(adaptive&&next.resourceReadyAt&&next.scheduledAt.getTime()>Date.now()){
      this.wake(next.scheduledAt);
      await this.db.engineState.update({where:{id:1},data:{status:`Saved random interval before MIX #${next.sequence}: ${next.scheduledAt.toISOString()}`}});return;
    }
    if(!adaptive&&next.scheduledAt.getTime()>Date.now()){
      await this.db.engineState.update({where:{id:1},data:{status:`Next ${next.kind} #${next.sequence}: ${next.scheduledAt.toISOString()}; waiting for its time and live resource check`}});return;
    }
    for(const a of next.allocations){
      const position=await this.db.ownershipBalance.findUnique({where:{campaignId_ownerAddress_holderAddress:{campaignId:c.id,ownerAddress:a.ownerAddress,holderAddress:next.from}}});
      if(!position||position.amountSun<a.amountSun)throw new OwnershipError(`Planned #${next.sequence} cannot spend ${a.ownerAddress}'s attributed share`);
    }
    await this.executeTransfer(next,b,adaptive?{minimum:ADAPTIVE_BANDWIDTH,bufferMs:0}:undefined);
  }

  private async paceTransfer(next:Transfer){
    // New complete plans only; keep legacy recovery semantics unchanged.
    if(!next.campaignId)return false;
    const previous=await this.db.transfer.findFirst({where:{status:'CONFIRMED'},orderBy:[{confirmedAt:'desc'},{updatedAt:'desc'}]});
    if(!previous)return false;
    let delay=next.pacingDelayMs;
    if(next.pacingAfterId!==previous.id||delay===null){
      const snapshot=await this.tron.bandwidthSnapshot(next.from);
      const full=snapshot.limit>0&&snapshot.available>=snapshot.limit;
      delay=full?randomInt(60_000,120_001):randomInt(300_000,600_001);
      await this.db.transfer.update({where:{id:next.id},data:{pacingAfterId:previous.id,pacingDelayMs:delay}});
    }
    const until=new Date((previous.confirmedAt??previous.updatedAt).getTime()+delay!);
    if(until.getTime()<=Date.now())return false;
    await this.delayTransfer(next,until,`Random gap after #${previous.sequence}: ${Math.ceil(delay!/1000)} seconds; resource check still required`);
    this.wake(until);
    await this.db.engineState.update({where:{id:1},data:{status:`Random interval before #${next.sequence}: ${until.toISOString()}`}});
    return true;
  }
  private async executeTransfer(next:Transfer,b:PoolBalance[],policy?:BandwidthPolicy){
    if(next.campaignId){
      const [allocations,members]=await Promise.all([
        this.db.allocation.findMany({where:{transferId:next.id}}),this.db.campaignMember.findMany({where:{campaignId:next.campaignId}})
      ]);
      if(!allocations.length||allocations.reduce((n,a)=>n+a.amountSun,0)!==next.amountSun||
        allocations.some(a=>!Number.isSafeInteger(a.amountSun)||a.amountSun<=0||!members.some(m=>m.address===a.ownerAddress)))
        throw new OwnershipError(`Invalid frozen contributions before signing #${next.sequence}`);
      for(const a of allocations){
        const position=await this.db.ownershipBalance.findUnique({where:{campaignId_ownerAddress_holderAddress:{campaignId:next.campaignId,ownerAddress:a.ownerAddress,holderAddress:next.from}}});
        if(!position||position.amountSun<a.amountSun)throw new OwnershipError(`Ownership deficit before signing #${next.sequence}`);
      }
      if(next.kind==='PAYOUT'&&(allocations.length!==1||allocations[0].ownerAddress!==next.from||next.amountSun!==TARGET))
        throw new OwnershipError('Teacher payout cannot spend another participant\'s attributed stake');
    }
    if(next.campaignId&&["MIX","RETURN"].includes(next.kind)&&!policy){
      const last=await this.db.transfer.findFirst({where:{from:next.from,status:"CONFIRMED"},orderBy:{sequence:"desc"}});
      if(last&&(last.confirmedAt??last.updatedAt).getTime()+DAY>Date.now()){
        const until=new Date((last.confirmedAt??last.updatedAt).getTime()+DAY);
        await this.delayTransfer(next,until,"Conservative daily sender slot after the last confirmed transfer");
        await this.db.engineState.update({where:{id:1},data:{status:`Waiting for the next daily sender slot: ${until.toISOString()}`}});return;
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
      if(policy?await this.adaptivePacing(next):await this.paceTransfer(next))return;
      await this.db.engineState.update({where:{id:1},data:{status:`Preflight ${next.kind.toLowerCase()} #${next.sequence} from ${next.from}`}});
      let prepared;
      try{prepared=await this.tron.prepare(next.from,next.to,next.amountSun,async()=>{
        if(next.campaignId)await this.db.campaign.updateMany({where:{id:next.campaignId,executionStartedAt:null},data:{executionStartedAt:new Date(Date.now())}});
      },policy);}catch(e){
        if(e instanceof BandwidthWait){
          if(policy){await this.waitForAdaptiveResource(next,await this.tron.bandwidthSnapshot(next.from),Math.max(ADAPTIVE_BANDWIDTH,e.requiredBandwidth));return;}
          await this.delayTransfer(next,e.nextCheckAt,`Bandwidth: ${e.message}`);
          await this.db.engineState.update({where:{id:1},data:{status:`Waiting for bandwidth: ${next.from}; ${e.message}`}});return;
        }throw e;
      }
      // Persist tx ID BEFORE broadcast. Any crash/error from this point pauses, never rebuilds.
      await this.db.transfer.update({where:{id:next.id},data:{status:'SUBMITTING',txId:prepared.txId,signedJson:prepared.signedJson,note:`Preflight ${prepared.bytes} bytes`}});
      try{
        await this.tron.broadcast(next.from,next.to,next.amountSun,prepared.txId,prepared.signedJson,prepared.bytes,policy);
        await this.db.transfer.update({where:{id:next.id},data:{status:'SUBMITTED'}});
        await this.audit('SUBMITTED',`${next.kind} #${next.sequence} tx ${prepared.txId}`,next.id);
        await this.db.engineState.update({where:{id:1},data:{status:`Waiting for receipt: ${next.kind.toLowerCase()} #${next.sequence}`}});
        if(policy)this.wake(new Date(Date.now()+10_000));
      }catch(e){
        if(e instanceof BandwidthWait){
          // This typed error is thrown before any network broadcast call.
          await this.db.transfer.update({where:{id:next.id},data:{status:'APPROVED',txId:null,signedJson:null}});
          if(policy){await this.waitForAdaptiveResource(next,await this.tron.bandwidthSnapshot(next.from),Math.max(ADAPTIVE_BANDWIDTH,e.requiredBandwidth));return;}
          await this.delayTransfer(next,e.nextCheckAt,`Bandwidth changed before broadcast: ${e.message}`);
          await this.db.engineState.update({where:{id:1},data:{status:`Waiting for bandwidth before transfer #${next.sequence}: ${e.message}`}});
          return;
        }
        // The node may have accepted the signed transaction despite an RPC
        // error. Keep its ID and wait for chain evidence, even after a restart.
        await this.db.transfer.update({where:{id:next.id},data:{note:`Broadcast outcome uncertain: ${String(e)}`}});
        await this.audit('BROADCAST_UNCERTAIN',`Persisted tx ${prepared.txId}; polling without rebroadcast`,next.id);
        await this.db.engineState.update({where:{id:1},data:{status:`Broadcast response uncertain for ${prepared.txId}; recovering by txID`}});
      }
  }

  private async delayTransfer(t:Transfer,until:Date,note:string){
    const delta=Math.max(0,until.getTime()-t.scheduledAt.getTime());
    await this.db.$transaction(async tx=>{
      if(t.campaignId&&delta>0){
        const rows=await tx.transfer.findMany({where:{campaignId:t.campaignId,sequence:{gt:t.sequence},status:{in:['PLANNED','APPROVED','PAUSED']},
          ...(t.kind==='MIX'?{}:{from:t.from})},select:{id:true,scheduledAt:true}});
        for(const row of rows)await tx.transfer.update({where:{id:row.id},data:{scheduledAt:new Date(row.scheduledAt.getTime()+delta)}});
      }
      await tx.transfer.update({where:{id:t.id},data:{scheduledAt:until,note}});
      if(t.campaignId)await tx.audit.create({data:{event:'CAMPAIGN_DELAY',transferId:t.id,detail:`#${t.sequence} delayed to ${until.toISOString()}; dependent future windows shifted; routes, ownership and approvals retained`}});
    },{timeout:30_000});
  }
  private async tickBody(){
    let s=await this.state();
    if(['IDLE','PREPARING','COMPLETE','HALTED'].includes(s.phase))return;
    try{
      const active=await this.db.transfer.findFirst({where:{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}},orderBy:{sequence:'asc'}});
      let justConfirmed=false;
      if(active){if(active.status==='UNKNOWN'){await this.fatal('Ambiguous transaction requires manual investigation');return;}
        await this.resolveInFlight(active);
        if((await this.state()).phase==='HALTED')return;
        if((await this.db.transfer.findUniqueOrThrow({where:{id:active.id}})).status!=='CONFIRMED'){
          if(active.campaignId&&active.kind==='MIX'&&(await this.db.campaign.findUnique({where:{id:active.campaignId},select:{timingMode:true}}))?.timingMode==='BANDWIDTH')
            this.wake(new Date(Date.now()+10_000));
          return;
        }
        justConfirmed=true;
      }
      let b=await this.reconcile();if(!b)return;
      s=await this.state();
      if(s.activeCampaignId){
        const positions=await verifyOwnership(this.db,s.activeCampaignId);
        const members=await this.db.campaignMember.findMany({where:{campaignId:s.activeCampaignId}});
        const joined=await this.joined();
        for(const member of members){
          const owned=positions.filter(p=>p.holderAddress===member.address).reduce((n,p)=>n+p.amountSun,0);
          const wallet=joined.find(w=>w.address===member.address)!;
          if(b.find(w=>w.address===member.address)!.sun!==owned+wallet.entryBalanceSun!-TARGET)
            throw new OwnershipError(`Wallet ${member.address} differs from confirmed attributed funds and personal reserve`);
        }
      }
      if(CAMPAIGN_PHASES.includes(s.phase)){await this.tickCampaign(s,b);return;}
      if(s.phase==='LEGACY_PAUSED')return;
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
            await tx.engineState.update({where:{id:1},data:{phase:this.campaignOnly?'LEGACY_PAUSED':'MIXING',rebalanceFromSequence:null,
              lastPlanAt:null,mixAmountCursor:0,mixLastReceiver:null,
              status:`Rebalance complete: ${count} transfers; each joined wallet again has 1 TRX plus its protected extra Sun${this.campaignOnly?'; old mixer paused':''}`}});
            await tx.audit.create({data:{event:'REBALANCE_COMPLETE',detail:`${count} transfers confirmed; each joined wallet restored; ${this.campaignOnly?'old mixer paused for the new campaign':'mixing resumed'}`}});
          });
          if(!this.campaignOnly)await this.plan(b);
          return;
        }
        if(s.phase==='SETTLING'){
          const joined=await this.joined();
          if(b.some(w=>w.sun!==joined.find(j=>j.address===w.address)!.entryBalanceSun!-TARGET)){await this.fatal('Settlement queue exhausted without restoring protected extra Sun');return;}
          await this.db.$transaction(async tx=>{
            await tx.engineState.update({where:{id:1},data:{phase:'COMPLETE',status:'Complete: each joined wallet sent exactly 1 TRX; protected extra Sun remains in its wallet'}});
            if(s.activeCampaignId)await tx.campaign.update({where:{id:s.activeCampaignId},data:{status:'PAID'}});
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
      await this.executeTransfer(next,b);
    }catch(e){
      if(e instanceof OwnershipError){await this.fatal(e.message);return;}
      // RPC outages cannot be treated as a zero balance. Pause, preserve queue and retry.
      if((await this.state()).phase!=='HALTED')await this.db.engineState.update({where:{id:1},data:{status:`RPC unavailable or preflight failed: ${String(e)}; retrying safely`}});
      console.error('Engine tick:',e instanceof Error?e.message:String(e));
    }
  }
}
