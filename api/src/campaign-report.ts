import type {PrismaClient} from '@prisma/client';
import {TARGET} from './config.js';
import {replayOwnership,type OwnedTransfer} from './ownership.js';
import type {Profile} from './campaign-plan.js';
import {loadVariant,planRows} from './plan-variants.js';
import type {PlanVariant} from '@prisma/client';
import {loadPrehistory,prependPrehistory} from './report-prehistory.js';

export {ownershipFlow,shapeSignature} from './ownership-flow.js';
import {ownershipFlow,shapeSignature} from './ownership-flow.js';

// These are public read models. Do not take SQLite's global write lock
// with an interactive transaction, and render DAGs after releasing DB work.
export async function campaignSummary(db:PrismaClient){
  const state=await db.engineState.findUniqueOrThrow({where:{id:1}});
  if(state.phase==='PREPARING'&&state.selectedPlanVariantId){
    const v=await db.planVariant.findUniqueOrThrow({where:{id:state.selectedPlanVariantId}});
    return draftSummary(v);
  }
  if(!state.activeCampaignId)return null;
  const c=await db.campaign.findUniqueOrThrow({where:{id:state.activeCampaignId},include:{members:{orderBy:{ordinal:'asc'}},positions:true}});
  const rows=await db.transfer.findMany({where:{campaignId:c.id},select:{status:true,kind:true,scheduledAt:true,from:true}});
  const pending=rows.filter(t=>!['CANCELLED','CONFIRMED'].includes(t.status));
  const forecastEndsAt=pending.length?new Date(Math.max(...pending.map(t=>t.scheduledAt.getTime()))):null;
  return {...c,members:c.members.map(m=>({...m,profile:JSON.parse(m.profileJson) as Profile,profileJson:undefined})),
    total:rows.filter(t=>t.status!=='CANCELLED').length,confirmed:rows.filter(t=>t.status==='CONFIRMED').length,
    mixingTransfers:rows.filter(t=>t.kind==='MIX'&&t.status!=='CANCELLED').length,
    forecastEndsAt,deadlineRisk:forecastEndsAt!==null&&forecastEndsAt.getTime()>c.deadlineAt.getTime()-4*86_400_000};
}
export async function ownerReport(db:PrismaClient,address:string,campaignId?:string,options:{includePrehistory?:boolean}={}){
  const s=await db.engineState.findUniqueOrThrow({where:{id:1}});
  if(!campaignId&&s.phase==='PREPARING'&&s.selectedPlanVariantId){
    const v=await db.planVariant.findUniqueOrThrow({where:{id:s.selectedPlanVariantId}});
    const report=variantOwnerReport(v,address);
    return report&&options.includePrehistory?includeReportPrehistory(db,report,s.nextSequence):report;
  }
  const id=campaignId??s.activeCampaignId;if(!id)return null;
  const campaign=await db.campaign.findUnique({where:{id},include:{members:{orderBy:{ordinal:'asc'}}}});
  if(!campaign||!campaign.members.some(m=>m.address===address))return null;
  const rows=await db.transfer.findMany({where:{campaignId:id},orderBy:{sequence:'asc'},
    select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,campaignDay:true,scheduledAt:true,
      plannedAt:true,confirmedAt:true,updatedAt:true,bandwidthUsed:true,txId:true,note:true,allocations:{select:{ownerAddress:true,amountSun:true}}}});
  const report=makeOwnerReport(address,campaign,rows);
  return options.includePrehistory?includeReportPrehistory(db,report,rows.reduce((min,t)=>Math.min(min,t.sequence),s.nextSequence)):report;
}

type ReportRow=OwnedTransfer & {campaignDay:number|null;scheduledAt:Date;plannedAt:Date|null;confirmedAt:Date|null;updatedAt?:Date;
  bandwidthUsed:number|null;txId:string|null;note:string|null};
type ReportCampaign={id:string;status:string;startedAt:Date;deadlineAt:Date;totalDays:number;mixingDays:number;
  timingMode?:string;
  variantId?:string;members:{address:string;ordinal:number;profileJson:string}[]};
function makeOwnerReport(address:string,campaign:ReportCampaign,rows:ReportRow[]){
    const active=rows.filter(t=>t.status!=='CANCELLED');
    const members=campaign.members.map(m=>m.address);
    const confirmedPositions=replayOwnership(members,active.filter(t=>t.status==='CONFIRMED'));
    const plannedPositions=replayOwnership(members,active);
    const flow=ownershipFlow(address,active);
    // Two holder compositions after each relevant movement make the report
    // useful without requiring a second request per row.
    const stock=new Map(members.map(m=>[`${m}:${m}`,TARGET]));
    const events=[];
    for(const row of active){
      for(const a of row.allocations){
        const source=`${row.from}:${a.ownerAddress}`,to=`${row.to}:${a.ownerAddress}`;
        stock.set(source,(stock.get(source)??0)-a.amountSun);
        // Reports keep attributed teacher receipts as well. They describe
        // this campaign's payments, never the teacher's unrelated balance.
        stock.set(to,(stock.get(to)??0)+a.amountSun);
      }
      const own=row.allocations.find(a=>a.ownerAddress===address);
      if(own){
        const composition=(holder:string)=>members.flatMap(owner=>{const sun=stock.get(`${holder}:${owner}`)??0;
          return sun>0?[{ownerAddress:owner,amountSun:sun}]:[];});
        events.push({...row,ownerSun:own.amountSun,fromComposition:composition(row.from),toComposition:composition(row.to)});
      }
    }
    const member=campaign.members.find(m=>m.address===address)!;
    return {address,campaign:{...campaign,members:campaign.members.map(m=>({address:m.address,ordinal:m.ordinal}))},
      prehistory:null as Awaited<ReturnType<typeof loadPrehistory>>|null,
      profile:JSON.parse(member.profileJson) as Profile,events,cancelled:rows.filter(t=>t.status==='CANCELLED'&&t.allocations.some(a=>a.ownerAddress===address)),
      positions:confirmedPositions.filter(p=>p.ownerAddress===address),finalPositions:plannedPositions.filter(p=>p.ownerAddress===address),
      flow,shapeSignature:shapeSignature(flow),actualSends:active.filter(t=>t.from===address&&t.status==='CONFIRMED').length,
      plannedMixSends:active.filter(t=>t.from===address&&t.kind==='MIX').length};
}
export async function includeReportPrehistory(db:PrismaClient,report:ReturnType<typeof makeOwnerReport>,beforeSequence?:number){
  const boundary=beforeSequence??(await db.engineState.findUniqueOrThrow({where:{id:1},select:{nextSequence:true}})).nextSequence;
  const prehistory=await loadPrehistory(db,report.address,boundary);
  return {...report,prehistory,flow:prependPrehistory(report.address,prehistory,report.flow)};
}
function draftCampaign(v:PlanVariant,loaded=loadVariant(v)){
  const {members,plan}=loaded;
  return {id:v.id,variantId:v.id,status:'DRAFT',startedAt:v.anchorAt,deadlineAt:v.deadlineAt,totalDays:v.totalDays,mixingDays:plan.mixingDays,
    members:members.map((m,i)=>({...m,profileJson:JSON.stringify(plan.profiles[i])}))};
}
function draftSummary(v:PlanVariant){
  const loaded=loadVariant(v),{members,plan}=loaded,c=draftCampaign(v,loaded);
  const forecastEndsAt=new Date(Math.max(...plan.steps.map(t=>t.plannedAt.getTime())));
  return {...c,draft:true,payAfterReturn:false,positions:members.map(m=>({ownerAddress:m.address,holderAddress:m.address,amountSun:TARGET})),
    members:members.map((m,i)=>({...m,profile:plan.profiles[i]})),total:plan.steps.length,confirmed:0,
    mixingTransfers:plan.steps.filter(t=>t.kind==='MIX').length,forecastEndsAt,deadlineRisk:forecastEndsAt.getTime()>v.deadlineAt.getTime()-4*86_400_000};
}
export function variantOwnerReport(v:PlanVariant,address:string){
  const loaded=loadVariant(v),{members,plan}=loaded;if(!members.some(m=>m.address===address))return null;
  return makeOwnerReport(address,draftCampaign(v,loaded),planRows(plan,v.id));
}

function csvCell(value:unknown){
  let text=value===null||value===undefined?'':String(value);
  // Protect spreadsheet consumers against formulas in notes/provider data.
  if(/^[=+@\-\t\r]/.test(text))text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export function reportCsv(report:NonNullable<Awaited<ReturnType<typeof ownerReport>>>){
  const date=(d:Date|null)=>d?d.toISOString():'';
  const msk=(d:Date)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(d)+' MSK';
  const compose=(a:{ownerAddress:string;amountSun:number}[])=>a.map(p=>`${p.ownerAddress}: ${(p.amountSun/TARGET).toFixed(6)} TRX`).join('; ');
  const header=['campaign_id','stake_owner_address','campaign_day','sequence','kind','status','planned_utc','scheduled_utc','scheduled_msk',
    'confirmed_utc','from_address','to_address','owner_amount_sun','owner_amount_trx','native_amount_sun','native_amount_trx',
    'packet_ownership','from_game_balance_after_sun','to_game_balance_after_sun','from_wallet_ownership_after','to_wallet_ownership_after','bandwidth_whole_transaction','tx_id','timing_mode',
    'report_section','attribution_basis','transfer_mode','source_campaign_id','recorded_confirmation_utc','execution_msk','execution_time_basis',
    'attribution_method','history_period_id','history_complete','history_initial_stake_sun'];
  const history=(report.prehistory?.events??[]).map(t=>[report.campaign.id,report.address,'',t.sequence,t.kind,t.status,
    date(t.plannedAt),date(t.scheduledAt),msk(t.scheduledAt),date(t.confirmedAt),t.from,t.to,
    t.ownerSun,t.ownerSun===null?'':(t.ownerSun/TARGET).toFixed(6),t.amountSun,(t.amountSun/TARGET).toFixed(6),
    compose(t.allocations),t.fromComposition.reduce((n,a)=>n+a.amountSun,0),t.toComposition.reduce((n,a)=>n+a.amountSun,0),
    compose(t.fromComposition),compose(t.toComposition),t.bandwidthUsed,t.txId,'',
    'PREHISTORY',t.attributionBasis,t.legacyMode,t.campaignId,date(t.updatedAt),msk(t.confirmedAt??t.updatedAt),t.confirmedAt?'BLOCK':'RECORD',
    t.attributionMethod,t.periodId,report.prehistory!.complete,TARGET]);
  const rows=report.events.map(t=>[report.campaign.id,report.address,t.campaignDay,t.sequence,t.kind,t.status,
    date(t.plannedAt),date(t.scheduledAt),msk(t.scheduledAt),date(t.confirmedAt),t.from,t.to,t.ownerSun,
    (t.ownerSun/TARGET).toFixed(6),t.amountSun,(t.amountSun/TARGET).toFixed(6),compose(t.allocations),
    t.fromComposition.reduce((n,a)=>n+a.amountSun,0),t.toComposition.reduce((n,a)=>n+a.amountSun,0),
    compose(t.fromComposition),compose(t.toComposition),t.bandwidthUsed,t.txId,report.campaign.timingMode??'DAILY',
    'CAMPAIGN','RECORDED',t.kind==='MIX'?'SMART':t.kind,report.campaign.variantId?'':report.campaign.id,
    t.status==='CONFIRMED'?date(t.updatedAt??t.confirmedAt):'',
    t.status==='CONFIRMED'&&(t.confirmedAt||t.updatedAt)?msk((t.confirmedAt??t.updatedAt)!):'',
    t.status==='CONFIRMED'?(t.confirmedAt?'BLOCK':t.updatedAt?'RECORD':'UNKNOWN'):'',
    'RECORDED','','','']);
  return '\uFEFF'+[header,...history,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
