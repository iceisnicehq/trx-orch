import type {PrismaClient} from '@prisma/client';
import {TARGET} from './config.js';
import {ownershipFlow,type FlowNode,type FlowEdge} from './ownership-flow.js';
import {reconstructPrehistory,type HistoricalMovement} from './legacy-attribution.js';

type ModeAudit={id:number;event:string;detail:string;transferId:string|null};
type ContextNode=FlowNode;
type ContextEdge=Omit<FlowEdge,'amountSun'>&{amountSun:number|null};
export type PrehistoryEvent=HistoricalMovement & {ownerSun:number;reportSection:'PREHISTORY';legacyMode:string;periodId:string};
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

async function readSnapshot(db:PrismaClient,beforeSequence:number){
  const [rows,audits,wallets]=await Promise.all([
    db.transfer.findMany({where:{status:'CONFIRMED',sequence:{lt:beforeSequence}},orderBy:{sequence:'asc'},
      select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,campaignId:true,scheduledAt:true,
        plannedAt:true,confirmedAt:true,updatedAt:true,createdAt:true,bandwidthUsed:true,txId:true,
        allocations:{select:{ownerAddress:true,amountSun:true}}}}),
    db.audit.findMany({where:{event:{in:['MIX_AMOUNT_MODE','QUEUED','PLAN']}},orderBy:{id:'asc'},
      select:{id:true,event:true,detail:true,transferId:true}}),
    db.wallet.findMany({orderBy:{ordinal:'asc'},select:{address:true,ordinal:true}})
  ]);
  return {...reconstructPrehistory(rows,wallets.map(w=>w.address)),modes:historicalModes(audits),wallets};
}
type Snapshot=Awaited<ReturnType<typeof readSnapshot>>;
const caches=new WeakMap<PrismaClient,Map<string,{at:number;pending:Promise<Snapshot>}>>();
const MAX_CACHE=8,TTL=5*60_000;
/** Cache all owners' deterministic replay once per historical boundary.
 * A cheap DB revision check detects newly confirmed/repaired/deleted rows.
 * No RPC, interactive transaction, writes or approvals occur on this path.
 * A restart simply rebuilds the cache from the durable transfer journal. */
async function snapshot(db:PrismaClient,beforeSequence:number){
  const [rows,audits]=await Promise.all([
    db.transfer.aggregate({where:{status:'CONFIRMED',sequence:{lt:beforeSequence}},
      _count:true,_max:{sequence:true,updatedAt:true}}),
    db.audit.aggregate({where:{event:{in:['MIX_AMOUNT_MODE','QUEUED','PLAN']}},_max:{id:true}})
  ]);
  const key=JSON.stringify([beforeSequence,rows._count,rows._max.sequence,rows._max.updatedAt,audits._max.id]);
  let cache=caches.get(db);if(!cache){cache=new Map();caches.set(db,cache);}
  const now=Date.now(),existing=cache.get(key);
  if(existing&&now-existing.at<TTL)return existing.pending;
  const pending=readSnapshot(db,beforeSequence);cache.set(key,{at:now,pending});
  while(cache.size>MAX_CACHE)cache.delete(cache.keys().next().value!);
  try{return await pending;}catch(error){if(cache.get(key)?.pending===pending)cache.delete(key);throw error;}
}

export async function loadPrehistory(db:PrismaClient,address:string,beforeSequence:number){
  const data=await snapshot(db,beforeSequence),segments=data.segments.flatMap(period=>{
    const events:PrehistoryEvent[]=period.movements.flatMap(row=>{
      const ownerSun=row.allocations.find(a=>a.ownerAddress===address)?.amountSun??0;
      if(ownerSun<=0)return [];
      return [{...row,ownerSun,reportSection:'PREHISTORY',periodId:period.id,
        legacyMode:row.kind==='MIX'?(row.campaignId?'SMART':data.modes.get(row.id)??'LEGACY'):row.kind}];
    });
    return events.length?[{id:period.id,campaignId:period.campaignId,events,
      positions:period.positions.filter(p=>p.ownerAddress===address),issue:period.issue}]:[];
  });
  const events=segments.flatMap(s=>s.events),last=segments.at(-1);
  const issues=data.issues.filter(issue=>{
    const period=data.segments.find(s=>s.issue===issue)!;
    return segments.some(s=>s.id===period.id)||period.movements.length===0;
  });
  return {enabled:true,scope:'PERSONAL_ATTRIBUTION' as const,method:'FIFO' as const,events,segments,
    wallets:data.wallets,reconstructedCount:events.filter(e=>e.attributionBasis==='RECONSTRUCTED').length,
    recordedCount:events.filter(e=>e.attributionBasis==='RECORDED').length,
    positionsAtEnd:last?.positions??[],issues,complete:issues.length===0,
    notice:'Показаны только прежние переводы, несущие долю этого участника. В RANDOM/LIST она рассчитана по FIFO: каждый участник начинает со ставки 1 TRX, раньше поступившие средства расходуются первыми. Это выбранное правило учёта, а не доказательство принадлежности отдельных Sun в TRON. Сохранённые доли прежних SMART-кампаний используются напрямую. Ребаланс включён как обычный перевод; он не сбрасывает FIFO. Граница SMART означает новый учёт ставки, а не перевод.'};
}

/** Personal DAG only: peer-to-peer hops are present exactly when this owner's
 * share travelled through them. A recorded accounting reset is a checkpoint,
 * never a fictitious native transfer, and joins every remaining old branch. */
export function prependPrehistory(owner:string,history:Awaited<ReturnType<typeof loadPrehistory>>,flow:ReturnType<typeof ownershipFlow>){
  if(!history.events.length)return flow;
  const nodes:ContextNode[]=[],edges:ContextEdge[]=[];
  let base=0,terminals:string[]=[];
  function checkpoint(title:string){
    const id='history:boundary:'+nodes.length;
    nodes.push({id,type:'checkpoint',wallet:owner,amountSun:TARGET,day:0,status:'BOUNDARY',rank:base,
      section:'PREHISTORY',checkpointTitle:title});
    for(const [i,from] of terminals.entries())edges.push({id:id+':from:'+i,from,to:id,amountSun:null,status:'CONTEXT',section:'PREHISTORY'});
    base++;return id;
  }
  for(const [index,period] of history.segments.entries()){
    const prefix='history:'+period.id+':',incoming=index?checkpoint(period.campaignId?'Начало прежнего SMART':'Новый период учёта'):null;
    const previous=ownershipFlow(owner,period.events.map(e=>({...e,campaignDay:0})));
    const events=new Map(period.events.map(e=>[e.sequence,e]));
    for(const node of previous.nodes){
      const event=node.sequence===undefined?undefined:events.get(node.sequence);
      nodes.push({...node,id:prefix+node.id,rank:node.rank+base,section:'PREHISTORY',
        attributionBasis:event?.attributionBasis??(period.campaignId?'RECORDED':'RECONSTRUCTED'),
        attributionMethod:event?.attributionMethod??(period.campaignId?'RECORDED':'FIFO'),
        toWallet:node.type==='transfer'?event?.to:undefined,mode:event?.legacyMode,
        at:event?(event.confirmedAt??event.updatedAt).toISOString():undefined});
    }
    for(const edge of previous.edges)edges.push({...edge,id:prefix+edge.id,from:prefix+edge.from,to:prefix+edge.to,section:'PREHISTORY'});
    if(incoming)edges.push({id:incoming+':next',from:incoming,to:prefix+'root',amountSun:null,status:'CONTEXT',section:'PREHISTORY'});
    const departed=new Set(previous.edges.map(e=>e.from));
    terminals=previous.nodes.filter(n=>n.type==='holding'&&!departed.has(n.id)).map(n=>prefix+n.id);
    base+=previous.nodes.reduce((max,n)=>Math.max(max,n.rank),0)+1;
  }
  const boundary=checkpoint('Начало выбранного SMART');
  edges.push({id:boundary+':plan',from:boundary,to:'root',amountSun:null,status:'CONTEXT',section:'PREHISTORY'});
  return {...flow,nodes:[...nodes,...flow.nodes.map(n=>({...n,rank:n.rank+base}))],edges:[...edges,...flow.edges]};
}
