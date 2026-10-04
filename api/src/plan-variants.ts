import {z} from 'zod';
import type {PlanVariant,Prisma,PrismaClient} from '@prisma/client';
import {buildCampaignPlan,DAY,UNIT,type CampaignPlan,type Member} from './campaign-plan.js';
import {ownershipFlow,shapeSignature} from './ownership-flow.js';
import {replayOwnership} from './ownership.js';
type Db=PrismaClient|Prisma.TransactionClient;
export function planRows(plan:CampaignPlan,id='preview',sequence=1){
  return plan.steps.map((s,i)=>({id:`draft:${id}:${i}`,sequence:sequence+i,kind:s.kind,status:'DRAFT',from:s.from,to:s.to,
    amountSun:s.amountSun,campaignDay:s.day,scheduledAt:s.plannedAt,plannedAt:s.plannedAt,confirmedAt:null,
    bandwidthUsed:null,txId:null,note:null,campaignId:id,allocations:s.allocations}));
}
export function planMetrics(members:Member[],plan:CampaignPlan){
  const rows=planRows(plan);
  const owners=members.map((m,i)=>{
    const flow=ownershipFlow(m.address,rows);
    return {...m,steps:rows.filter(t=>t.allocations.some(a=>a.ownerAddress===m.address)).length,
      splits:flow.splits,merges:flow.merges,mixSends:rows.filter(t=>t.from===m.address&&t.kind==='MIX').length,
      returnSends:rows.filter(t=>t.from===m.address&&t.kind==='RETURN').length,shape:shapeSignature(flow),profile:plan.profiles[i]};
  });
  function range(key:'steps'|'splits'|'merges'){
    const values=owners.map(m=>m[key]),mean=values.reduce((a,b)=>a+b,0)/values.length;
    const tolerance=key==='steps'?Math.max(2,Math.ceil(mean*.1)):Math.max(2,Math.ceil(mean*.2));
    return {min:Math.min(...values),max:Math.max(...values),mean,lower:Math.max(0,Math.floor(mean)-tolerance),upper:Math.ceil(mean)+tolerance};
  }
  const steps=range('steps'),splits=range('splits'),merges=range('merges');
  const distinct=new Set(owners.map(m=>m.shape)).size===owners.length;
  const balanced=distinct&&owners.every(m=>m.steps>=steps.lower&&m.steps<=steps.upper&&m.splits>=splits.lower&&m.splits<=splits.upper);
  return {owners,steps,splits,merges,distinct,balanced,total:rows.length,mixingDays:plan.mixingDays,
    policy:'Steps: mean ±10% (minimum 2); branches: mean ±20% (minimum 2), integer rounding; distinct weighted shapes'};
}
export function buildBalancedPlan(members:Member[],seed:string,anchorAt:Date,totalDays=36){
  for(let attempt=0;attempt<128;attempt++){
    const plan=buildCampaignPlan(members,`${seed}:${attempt}`,anchorAt,totalDays),metrics=planMetrics(members,plan);
    if(metrics.balanced)return {plan,metrics};
  }
  throw Error('Could not build a balanced distinct plan; retry generation. No transactions were created.');
}
const memberSchema=z.object({address:z.string().min(1).max(100),ordinal:z.number().int().min(0).max(16)});
const profileSchema=z.object({type:z.enum(['QUARTERS','LATE_QUARTERS','EIGHTHS']),releaseDay:z.number().int().positive(),
  quarterDay:z.number().int().positive(),eighthDay:z.number().int().positive().nullable()});
const stepSchema=z.object({kind:z.enum(['MIX','RETURN']),from:z.string(),to:z.string(),amountSun:z.number().int().positive().max(17_000_000),
  day:z.number().int().positive().max(60),offsetMs:z.number().int().nonnegative().max(61*DAY),dependsIndex:z.number().int().nonnegative().nullable(),
  allocations:z.array(z.object({ownerAddress:z.string(),amountSun:z.number().int().positive()})).min(1).max(17)});
const savedSchema=z.object({seed:z.string(),mixingDays:z.number().int().positive(),totalDays:z.number().int().min(18).max(60),
  profiles:z.array(profileSchema).min(2).max(17),steps:z.array(stepSchema).min(1).max(1500)});
export function serializePlan(plan:CampaignPlan,anchorAt:Date){
  return JSON.stringify({...plan,steps:plan.steps.map(({plannedAt,...s})=>({...s,offsetMs:plannedAt.getTime()-anchorAt.getTime()}))});
}
export function loadVariant(v:PlanVariant,anchorAt=v.anchorAt){
  const members=z.array(memberSchema).min(2).max(17).parse(JSON.parse(v.membersJson)),p=savedSchema.parse(JSON.parse(v.planJson));
  if(p.totalDays!==v.totalDays||p.mixingDays!==p.totalDays-8||p.profiles.length!==members.length||new Set(members.map(m=>m.address)).size!==members.length)
    throw Error('Invalid saved plan metadata');
  const addresses=new Set(members.map(m=>m.address)),slots=new Set<string>();
  const plan:CampaignPlan={...p,steps:p.steps.map(({offsetMs,...s})=>({...s,plannedAt:new Date(anchorAt.getTime()+offsetMs)}))};
  for(const [i,s] of plan.steps.entries()){
    if(!addresses.has(s.from)||!addresses.has(s.to)||s.from===s.to||s.amountSun%UNIT||s.day>p.totalDays||
      s.dependsIndex!==null&&s.dependsIndex>=i||s.allocations.some(a=>!addresses.has(a.ownerAddress)||a.amountSun%UNIT)||slots.has(`${s.from}:${s.day}`))
      throw Error('Invalid saved native transfer');
    slots.add(`${s.from}:${s.day}`);
  }
  const positions=replayOwnership(members.map(m=>m.address),planRows(plan));
  if(positions.length!==members.length||positions.some(p=>p.ownerAddress!==p.holderAddress||p.amountSun!==1_000_000))
    throw Error('Saved plan does not restore every original stake');
  return {members,plan,metrics:planMetrics(members,plan)};
}
export function swapPlan(members:Member[],plan:CampaignPlan,a:string,b:string){
  if(a===b||!members.some(m=>m.address===a)||!members.some(m=>m.address===b))throw Error('Choose two different plan members');
  const address=(value:string)=>value===a?b:value===b?a:value;
  const profiles=members.map(m=>plan.profiles[members.findIndex(old=>old.address===address(m.address))]);
  return {...plan,profiles,steps:plan.steps.map(s=>({...s,from:address(s.from),to:address(s.to),allocations:s.allocations.map(c=>({...c,ownerAddress:address(c.ownerAddress)}))}))};
}
export async function saveVariant(db:Db,members:Member[],plan:CampaignPlan,anchorAt:Date,deadlineAt:Date,
  extra:{parentId?:string;sourceCampaignId?:string;generatorVersion?:number}={}){
  const last=await db.planVariant.aggregate({_max:{number:true}});
  return db.planVariant.create({data:{number:(last._max.number??0)+1,membersJson:JSON.stringify(members.map(({address,ordinal})=>({address,ordinal}))),
    planJson:serializePlan(plan,anchorAt),metricsJson:JSON.stringify(planMetrics(members,plan)),anchorAt,deadlineAt,totalDays:plan.totalDays,...extra}});
}
export async function preparationPermission(db:Db){
  const s=await db.engineState.findUniqueOrThrow({where:{id:1}});
  if(!['IDLE','LEGACY_PAUSED','CAMPAIGN_RESTORED','PREPARING','CAMPAIGN'].includes(s.phase))return {canEdit:false,reason:`Preparation unavailable in ${s.phase}`};
  if(await db.transfer.count({where:{OR:[{status:{in:['SUBMITTING','SUBMITTED','UNKNOWN']}},{kind:'PAYOUT',status:'CONFIRMED'}]}}))
    return {canEdit:false,reason:'A transaction is in flight, uncertain, or this pool has already paid the teacher'};
  if(s.phase==='CAMPAIGN'){
    if(!s.activeCampaignId)return {canEdit:false,reason:'Missing campaign state'};
    const c=await db.campaign.findUniqueOrThrow({where:{id:s.activeCampaignId}});
    if(c.payAfterReturn||c.executionStartedAt||await db.transfer.count({where:{campaignId:c.id,OR:[{signedJson:{not:null}},{txId:{not:null}},{status:'CONFIRMED'}]}}))
      return {canEdit:false,reason:'The first transfer has begun signing. Restore stakes before preparing a new campaign.'};
  }
  return {canEdit:true,reason:null};
}
export async function variantList(db:PrismaClient){
  // UI permission is advisory; every admin mutation rechecks it under the
  // engine lock. Public listing must not block receipts or Telegram writes.
  const [s,rows]=await Promise.all([
    db.engineState.findUniqueOrThrow({where:{id:1}}),
    db.planVariant.findMany({orderBy:{number:'desc'},select:{id:true,number:true,totalDays:true,deadlineAt:true,anchorAt:true,
      createdAt:true,parentId:true,sourceCampaignId:true,generatorVersion:true,metricsJson:true}})
  ]);
  const permission=await preparationPermission(db);
  return {...permission,selectedId:s.selectedPlanVariantId,items:rows.map(v=>({id:v.id,number:v.number,totalDays:v.totalDays,
    deadlineAt:v.deadlineAt,anchorAt:v.anchorAt,createdAt:v.createdAt,parentId:v.parentId,sourceCampaignId:v.sourceCampaignId,
    generatorVersion:v.generatorVersion,metrics:JSON.parse(v.metricsJson) as ReturnType<typeof planMetrics>}))};
}
export async function selectedDraft(db:PrismaClient){
  const s=await db.engineState.findUniqueOrThrow({where:{id:1}});
  if(s.phase!=='PREPARING'||!s.selectedPlanVariantId)return null;
  const variant=await db.planVariant.findUniqueOrThrow({where:{id:s.selectedPlanVariantId}}),{members,plan}=loadVariant(variant);
  return {variant,members,plan,rows:planRows(plan,variant.id,s.nextSequence)};
}
