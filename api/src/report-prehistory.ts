import type {PrismaClient,Transfer} from '@prisma/client';
import type {Contribution} from './campaign-plan.js';
import {TARGET} from './config.js';
import type {FlowNode,FlowEdge,ownershipFlow} from './ownership-flow.js';

type HistoricalRow=Pick<Transfer,'id'|'sequence'|'kind'|'status'|'from'|'to'|'amountSun'|'campaignId'|
  'scheduledAt'|'plannedAt'|'confirmedAt'|'updatedAt'|'createdAt'|'bandwidthUsed'|'txId'> & {allocations:Contribution[]};
type ModeAudit={id:number;event:string;detail:string;transferId:string|null};
type ContextNode=Omit<FlowNode,'amountSun'>&{amountSun:number|null};
type ContextEdge=Omit<FlowEdge,'amountSun'>&{amountSun:number|null};
export type PrehistoryEvent=HistoricalRow & {ownerSun:number|null;reportSection:'PREHISTORY';
  attributionBasis:'UNRECORDED'|'RECORDED';legacyMode:string;fromComposition:null;toComposition:null};

/** Mode is read from the actual queue/audit, never guessed from the amount.
 * An older installation without these audit events remains labelled LEGACY. */
export function historicalModes(audits:ModeAudit[]){
  const modes=new Map<string,string>();let current='LEGACY',batch:string[]=[];
  for(const a of [...audits].sort((a,b)=>a.id-b.id)){
    if(a.event==='MIX_AMOUNT_MODE'){
      const mode=/^(RANDOM|LIST)\b/.exec(a.detail)?.[1];
      if(mode){current=mode;batch=[];}
    }else if(a.event==='QUEUED'&&a.transferId){
      modes.set(a.transferId,current);batch.push(a.transferId);
    }else if(a.event==='PLAN'){
      const mode=/^LIST\s+step\b/.test(a.detail)?'LIST':/\btransfers added within the next 24 hours\b/.test(a.detail)?'RANDOM':null;
      if(mode)for(const id of batch)modes.set(id,mode);
      batch=[];
    }
  }
  return modes;
}

/** Include the connected historical group. Legacy native transfers contain no
 * owner tags, so following only this address would omit subsequent peer hops,
 * while assigning an owner to those hops would invent provenance. */
export function connectedHistory(address:string,rows:HistoricalRow[]){
  const neighbours=new Map<string,Set<string>>();
  for(const row of rows){
    for(const [a,b] of [[row.from,row.to],[row.to,row.from]]){
      const peers=neighbours.get(a)??new Set<string>();peers.add(b);neighbours.set(a,peers);
    }
  }
  const visited=new Set([address]),open=[address];
  while(open.length){
    for(const peer of neighbours.get(open.pop()!)??[])if(!visited.has(peer)){visited.add(peer);open.push(peer);}
  }
  return rows.filter(row=>visited.has(row.from)&&visited.has(row.to)).sort((a,b)=>a.sequence-b.sequence);
}

export async function loadPrehistory(db:PrismaClient,address:string,beforeSequence:number){
  const [rows,audits,wallets]=await Promise.all([
    db.transfer.findMany({where:{status:'CONFIRMED',sequence:{lt:beforeSequence}},orderBy:{sequence:'asc'},
      select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,campaignId:true,scheduledAt:true,
        plannedAt:true,confirmedAt:true,updatedAt:true,createdAt:true,bandwidthUsed:true,txId:true,
        allocations:{select:{ownerAddress:true,amountSun:true}}}}),
    db.audit.findMany({where:{event:{in:['MIX_AMOUNT_MODE','QUEUED','PLAN']}},orderBy:{id:'asc'},
      select:{id:true,event:true,detail:true,transferId:true}}),
    db.wallet.findMany({orderBy:{ordinal:'asc'},select:{address:true,ordinal:true}})
  ]);
  const modes=historicalModes(audits),events:PrehistoryEvent[]=connectedHistory(address,rows).map(row=>{
    const recorded=Boolean(row.campaignId)&&row.allocations.length>0&&
      row.allocations.every(a=>Number.isSafeInteger(a.amountSun)&&a.amountSun>0)&&
      new Set(row.allocations.map(a=>a.ownerAddress)).size===row.allocations.length&&
      row.allocations.reduce((n,a)=>n+a.amountSun,0)===row.amountSun;
    return {...row,reportSection:'PREHISTORY',ownerSun:recorded?row.allocations.find(a=>a.ownerAddress===address)?.amountSun??0:null,
      attributionBasis:recorded?'RECORDED':'UNRECORDED',legacyMode:row.kind==='MIX'?(row.campaignId?'SMART':modes.get(row.id)??'LEGACY'):row.kind,
      fromComposition:null,toComposition:null};
  });
  return {enabled:true,scope:'CONNECTED_CONFIRMED' as const,events,wallets,
    unrecordedCount:events.filter(e=>e.attributionBasis==='UNRECORDED').length,
    notice:'Предыстория показывает подтверждённые переводы связанной группы кошельков до выбранного плана. В RANDOM/LIST доли владельцев не записывались: показана вся сумма перевода, а не доказанный путь именно этого 1 TRX. Связь со стартом SMART обозначает начало нового учёта, а не дополнительную транзакцию.'};
}

/** A chronological, factual wallet-state DAG, not an invented ownership DAG.
 * CONTEXT edges show order/state updates, with no invented money amount. */
export function prependPrehistory(owner:string,rows:PrehistoryEvent[],flow:ReturnType<typeof ownershipFlow>){
  if(!rows.length)return flow;
  const nodes:ContextNode[]=[],edges:ContextEdge[]=[],held=new Map<string,{id:string;rank:number}>();
  const initial=(address:string)=>{
    let state=held.get(address);
    if(!state){
      state={id:`history:initial:${address}`,rank:0};held.set(address,state);
      nodes.push({id:state.id,type:'holding',wallet:address,amountSun:null,day:0,status:'HISTORY',rank:0,section:'PREHISTORY'});
    }
    return state;
  };
  for(const row of rows){
    const source=initial(row.from),recipient=initial(row.to),rank=Math.max(source.rank,recipient.rank)+1;
    const id=`history:tx:${row.id}`,sent=`history:sent:${row.id}`,received=`history:received:${row.id}`;
    const at=(row.confirmedAt??row.updatedAt).toISOString();
    nodes.push({id,type:'transfer',wallet:row.from,toWallet:row.to,amountSun:row.amountSun,nativeSun:row.amountSun,
      day:0,sequence:row.sequence,status:'CONFIRMED',rank,section:'PREHISTORY',mode:row.legacyMode,at});
    nodes.push({id:sent,type:'holding',wallet:row.from,amountSun:null,day:0,sequence:row.sequence,status:'HISTORY',rank:rank+1,section:'PREHISTORY'});
    nodes.push({id:received,type:'holding',wallet:row.to,amountSun:null,day:0,sequence:row.sequence,status:'HISTORY',rank:rank+1,section:'PREHISTORY'});
    edges.push({id:`history:depart:${row.id}`,from:source.id,to:id,amountSun:row.amountSun,status:'CONFIRMED',section:'PREHISTORY'});
    edges.push({id:`history:arrive:${row.id}`,from:id,to:received,amountSun:row.amountSun,status:'CONFIRMED',section:'PREHISTORY'});
    edges.push({id:`history:sender-state:${row.id}`,from:id,to:sent,amountSun:null,status:'CONTEXT',section:'PREHISTORY'});
    edges.push({id:`history:recipient-state:${row.id}`,from:recipient.id,to:received,amountSun:null,status:'CONTEXT',section:'PREHISTORY'});
    held.set(row.from,{id:sent,rank:rank+1});held.set(row.to,{id:received,rank:rank+1});
  }
  const rank=nodes.reduce((max,n)=>Math.max(max,n.rank),0)+1,boundary='history:boundary';
  nodes.push({id:boundary,type:'checkpoint',wallet:owner,amountSun:TARGET,day:0,status:'BOUNDARY',rank,section:'PREHISTORY'});
  const previous=held.get(owner);
  if(previous)edges.push({id:'history:to-boundary',from:previous.id,to:boundary,amountSun:null,status:'CONTEXT',section:'PREHISTORY'});
  edges.push({id:'history:to-plan',from:boundary,to:'root',amountSun:null,status:'CONTEXT',section:'PREHISTORY'});
  return {...flow,nodes:[...nodes,...flow.nodes.map(n=>({...n,rank:n.rank+rank+1}))],edges:[...edges,...flow.edges]};
}
