import {TARGET} from './config.js';
import type {Contribution} from './campaign-plan.js';
import type {Transfer} from '@prisma/client';

export type HistoricalRow=Pick<Transfer,'id'|'sequence'|'kind'|'status'|'from'|'to'|'amountSun'|'campaignId'|
  'scheduledAt'|'plannedAt'|'confirmedAt'|'updatedAt'|'createdAt'|'bandwidthUsed'|'txId'> & {allocations:Contribution[]};
export type HistoricalMovement=HistoricalRow & {
  attributionBasis:'RECONSTRUCTED'|'RECORDED';
  attributionMethod:'FIFO'|'RECORDED';
  fromComposition:Contribution[];
  toComposition:Contribution[];
};
export type ReconstructionIssue={sequence:number;code:'MISSING_FUNDS'|'INVALID_ROW'|'INVALID_ALLOCATION';detail:string};
export type HistoricalSegment={id:string;campaignId:string|null;movements:HistoricalMovement[];
  positions:{holderAddress:string;ownerAddress:string;amountSun:number}[];
  issue:ReconstructionIssue|null};

type Lot={ownerAddress:string;amountSun:number};
const composition=(lots:Lot[])=>{
  const stock=new Map<string,number>();
  for(const lot of lots)stock.set(lot.ownerAddress,(stock.get(lot.ownerAddress)??0)+lot.amountSun);
  return [...stock].filter(([,sun])=>sun>0).sort(([a],[b])=>a.localeCompare(b))
    .map(([ownerAddress,amountSun])=>({ownerAddress,amountSun}));
};
function append(lots:Lot[],incoming:Lot[]){
  for(const lot of incoming){
    const last=lots.at(-1);
    if(last?.ownerAddress===lot.ownerAddress)last.amountSun+=lot.amountSun;
    else lots.push({...lot});
  }
}

/** A declared accounting convention, not recovered coin identities.
 * Each period begins with the application's one-TRX stakes. Legacy rows
 * consume the oldest incoming lots first. Rebalances are ordinary transfers:
 * equal native balances do NOT silently reset reconstructed ownership.
 * A recorded SMART campaign explicitly begins a new attribution period.
 * Incomplete data stops that period; never create funds to cover a gap. */
export function reconstructPrehistory(rows:HistoricalRow[],walletAddresses:string[]){
  const wallets=new Set(walletAddresses),segments:HistoricalSegment[]=[];
  let segment:HistoricalSegment|undefined,stock=new Map<string,Lot[]>();
  for(const row of [...rows].sort((a,b)=>a.sequence-b.sequence)){
    if(!segment||segment.campaignId!==row.campaignId){
      segment={id:'period-'+row.sequence,campaignId:row.campaignId,movements:[],positions:[],issue:null};
      segments.push(segment);
      stock=new Map([...wallets].map(address=>[address,[{ownerAddress:address,amountSun:TARGET}]]));
    }
    if(segment.issue)continue;
    const fail=(code:ReconstructionIssue['code'],detail:string)=>{
      segment!.issue={sequence:row.sequence,code,detail};
    };
    if(!Number.isSafeInteger(row.amountSun)||row.amountSun<=0||row.from===row.to||!wallets.has(row.from)){
      fail('INVALID_ROW','Invalid historical route or amount at #'+row.sequence);continue;
    }
    const source=stock.get(row.from)??[],target=stock.get(row.to)??[];
    if(source.reduce((sun,lot)=>sun+lot.amountSun,0)<row.amountSun){
      fail('MISSING_FUNDS','Recorded history cannot fund #'+row.sequence+' from the one-TRX starting stakes; the remaining period is not reconstructed');
      continue;
    }
    let allocations:Contribution[],incoming:Lot[];
    if(row.campaignId){
      allocations=row.allocations.map(a=>({...a}));
      incoming=allocations;
      if(!allocations.length||new Set(allocations.map(a=>a.ownerAddress)).size!==allocations.length||
        allocations.some(a=>!wallets.has(a.ownerAddress)||!Number.isSafeInteger(a.amountSun)||a.amountSun<=0)||
        allocations.reduce((sun,a)=>sun+a.amountSun,0)!==row.amountSun){
        fail('INVALID_ALLOCATION','Missing or invalid saved SMART allocations at #'+row.sequence);continue;
      }
      const available=new Map(composition(source).map(a=>[a.ownerAddress,a.amountSun]));
      if(allocations.some(a=>(available.get(a.ownerAddress)??0)<a.amountSun)){
        fail('INVALID_ALLOCATION','Saved SMART shares exceed their recorded holder at #'+row.sequence);continue;
      }
      // Saved ownership takes precedence over FIFO. All validation precedes
      // mutation, so an invalid row cannot consume even a partial lot.
      for(const allocation of allocations){
        let left=allocation.amountSun;
        for(const lot of source)if(lot.ownerAddress===allocation.ownerAddress&&left){
          const sent=Math.min(left,lot.amountSun);lot.amountSun-=sent;left-=sent;
        }
      }
    }else{
      let left=row.amountSun;const moved:Lot[]=[];
      for(const lot of source){
        if(!left)break;
        const sent=Math.min(left,lot.amountSun);
        if(sent){append(moved,[{ownerAddress:lot.ownerAddress,amountSun:sent}]);lot.amountSun-=sent;left-=sent;}
      }
      allocations=composition(moved);
      incoming=moved;
    }
    stock.set(row.from,source.filter(lot=>lot.amountSun>0));
    append(target,incoming);stock.set(row.to,target);
    const movement:HistoricalMovement={...row,allocations,
      attributionBasis:row.campaignId?'RECORDED':'RECONSTRUCTED',
      attributionMethod:row.campaignId?'RECORDED':'FIFO',
      fromComposition:composition(stock.get(row.from)!),toComposition:composition(target)};
    segment.movements.push(movement);
    segment.positions=[...stock].flatMap(([holderAddress,lots])=>composition(lots).map(a=>({...a,holderAddress})));
  }
  return {segments,issues:segments.flatMap(s=>s.issue?[s.issue]:[])};
}
