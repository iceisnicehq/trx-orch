import {createHash} from 'node:crypto';
import type {PrismaClient} from '@prisma/client';
import {TARGET} from './config.js';
import {replayOwnership,type OwnedTransfer} from './ownership.js';
import type {Profile} from './campaign-plan.js';

export type FlowNode={id:string;type:'holding'|'transfer';wallet:string;amountSun:number;nativeSun?:number;
  day:number;sequence?:number;status:string;rank:number};
export type FlowEdge={id:string;from:string;to:string;amountSun:number;status:string};
type ReportTransfer=OwnedTransfer & {campaignDay:number|null;scheduledAt:Date;plannedAt:Date|null;
  confirmedAt:Date|null;bandwidthUsed:number|null;txId:string|null;note:string|null};

/** Actual branching DAG: a partial departure leaves a holding branch;
 * receipt at a holder with this owner's funds merges its two predecessors.
 * Holding edges are explicitly separate from native transaction nodes. */
export function ownershipFlow(owner:string,rows:(OwnedTransfer & {campaignDay:number|null})[]){
  const nodes:FlowNode[]=[{id:'root',type:'holding',wallet:owner,amountSun:TARGET,day:0,status:'INITIAL',rank:0}];
  const edges:FlowEdge[]=[];
  const held=new Map([[owner,{id:'root',sun:TARGET,rank:0}]]);
  let splits=0,merges=0;
  for(const row of rows){
    const allocation=row.allocations.find(a=>a.ownerAddress===owner);if(!allocation)continue;
    const source=held.get(row.from);
    if(!source||source.sun<allocation.amountSun)throw Error(`Invalid owner graph at #${row.sequence}`);
    const incoming=held.get(row.to),rank=Math.max(source.rank,incoming?.rank??0)+1;
    const txId=`tx:${row.id}`,receiptId=`stock:${row.id}`,day=row.campaignDay??0;
    nodes.push({id:txId,type:'transfer',wallet:row.from,amountSun:allocation.amountSun,nativeSun:row.amountSun,
      day,sequence:row.sequence,status:row.status,rank});
    edges.push({id:`depart:${row.id}`,from:source.id,to:txId,amountSun:allocation.amountSun,status:row.status});
    if(source.sun>allocation.amountSun){
      splits++;
      const id=`remain:${row.id}`,sun=source.sun-allocation.amountSun;
      nodes.push({id,type:'holding',wallet:row.from,amountSun:sun,day,status:row.status,rank});
      edges.push({id:`retain:${row.id}`,from:source.id,to:id,amountSun:sun,status:'HOLD'});
      held.set(row.from,{id,sun,rank});
    }else held.delete(row.from);
    if(row.kind==='PAYOUT'){
      nodes.push({id:receiptId,type:'holding',wallet:row.to,amountSun:allocation.amountSun,day,status:row.status,rank:rank+1});
      edges.push({id:`arrive:${row.id}`,from:txId,to:receiptId,amountSun:allocation.amountSun,status:row.status});
      continue;
    }
    const sun=(incoming?.sun??0)+allocation.amountSun;
    nodes.push({id:receiptId,type:'holding',wallet:row.to,amountSun:sun,day,status:row.status,rank:rank+1});
    edges.push({id:`arrive:${row.id}`,from:txId,to:receiptId,amountSun:allocation.amountSun,status:row.status});
    if(incoming){merges++;edges.push({id:`merge:${row.id}`,from:incoming.id,to:receiptId,amountSun:incoming.sun,status:'HOLD'});}
    held.set(row.to,{id:receiptId,sun,rank:rank+1});
  }
  return {nodes,edges,splits,merges};
}

// Unequal invariant summaries guarantee different weighted graph shapes.
// Ignore addresses, dates and labels: changing only a name is insufficient.
export function shapeSignature(flow:ReturnType<typeof ownershipFlow>){
  const counters=new Map<string,number>();
  for(const n of flow.nodes){const key=`${n.type}:${n.amountSun}:${n.nativeSun??0}`;counters.set(key,(counters.get(key)??0)+1);}
  return createHash('sha256').update(JSON.stringify([flow.splits,flow.merges,[...counters].sort()])).digest('hex');
}

export async function campaignSummary(db:PrismaClient){
  return db.$transaction(async tx=>{
    const state=await tx.engineState.findUniqueOrThrow({where:{id:1}});
    if(!state.activeCampaignId)return null;
    const c=await tx.campaign.findUniqueOrThrow({where:{id:state.activeCampaignId},include:{members:{orderBy:{ordinal:'asc'}},positions:true}});
    const rows=await tx.transfer.findMany({where:{campaignId:c.id},select:{status:true,kind:true,scheduledAt:true,from:true}});
    const pending=rows.filter(t=>!['CANCELLED','CONFIRMED'].includes(t.status));
    const forecastEndsAt=pending.length?new Date(Math.max(...pending.map(t=>t.scheduledAt.getTime()))):null;
    return {...c,members:c.members.map(m=>({...m,profile:JSON.parse(m.profileJson) as Profile,profileJson:undefined})),
      total:rows.filter(t=>t.status!=='CANCELLED').length,confirmed:rows.filter(t=>t.status==='CONFIRMED').length,
      mixingTransfers:rows.filter(t=>t.kind==='MIX'&&t.status!=='CANCELLED').length,
      forecastEndsAt,deadlineRisk:forecastEndsAt!==null&&forecastEndsAt.getTime()>c.deadlineAt.getTime()-4*86_400_000};
  });
}

export async function ownerReport(db:PrismaClient,address:string,campaignId?:string){
  return db.$transaction(async tx=>{
    const s=await tx.engineState.findUniqueOrThrow({where:{id:1}});
    const id=campaignId??s.activeCampaignId;if(!id)return null;
    const campaign=await tx.campaign.findUnique({where:{id},include:{members:{orderBy:{ordinal:'asc'}}}});
    if(!campaign||!campaign.members.some(m=>m.address===address))return null;
    const rows=await tx.transfer.findMany({where:{campaignId:id},orderBy:{sequence:'asc'},
      select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,campaignDay:true,scheduledAt:true,
        plannedAt:true,confirmedAt:true,bandwidthUsed:true,txId:true,note:true,allocations:{select:{ownerAddress:true,amountSun:true}}}});
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
      profile:JSON.parse(member.profileJson) as Profile,events,cancelled:rows.filter(t=>t.status==='CANCELLED'&&t.allocations.some(a=>a.ownerAddress===address)),
      positions:confirmedPositions.filter(p=>p.ownerAddress===address),finalPositions:plannedPositions.filter(p=>p.ownerAddress===address),
      flow,shapeSignature:shapeSignature(flow),actualSends:active.filter(t=>t.from===address&&t.status==='CONFIRMED').length,
      plannedMixSends:active.filter(t=>t.from===address&&t.kind==='MIX').length};
  },{timeout:30_000});
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
    'packet_ownership','from_game_balance_after_sun','to_game_balance_after_sun','from_wallet_ownership_after','to_wallet_ownership_after','bandwidth_whole_transaction','tx_id'];
  const rows=report.events.map(t=>[report.campaign.id,report.address,t.campaignDay,t.sequence,t.kind,t.status,
    date(t.plannedAt),date(t.scheduledAt),msk(t.scheduledAt),date(t.confirmedAt),t.from,t.to,t.ownerSun,
    (t.ownerSun/TARGET).toFixed(6),t.amountSun,(t.amountSun/TARGET).toFixed(6),compose(t.allocations),
    t.fromComposition.reduce((n,a)=>n+a.amountSun,0),t.toComposition.reduce((n,a)=>n+a.amountSun,0),
    compose(t.fromComposition),compose(t.toComposition),t.bandwidthUsed,t.txId]);
  return '\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
