// Forecast only. The node's getBandwidth/getAccountResources response is the
// authority at broadcast time; other wallet activity can invalidate a forecast.
export const MIN_FREE_BANDWIDTH=400;
export const RECOVERY_WINDOW_MS=24*60*60_000;
export const RECOVERY_BUFFER_MS=60*60_000;
export type ForecastSpend={at:number;points:number};

export function projectedFree(limit:number,available:number,observedAt:number,at:number,spends:ForecastSpend[]=[]):number{
  const remaining=(points:number,since:number,when:number)=>points*Math.max(0,1-Math.max(0,when-since)/RECOVERY_WINDOW_MS);
  const measuredUsed=Math.max(0,limit-available);
  const known=spends.filter(s=>s.at<=observedAt&&s.at+RECOVERY_WINDOW_MS>observedAt);
  const knownNow=known.reduce((n,s)=>n+remaining(s.points,s.at,observedAt),0);
  // Account for earlier/external spending without inventing a transaction
  // timestamp. Giving the unknown part a fresh 24-hour window makes its
  // projected recovery conservative. Scale down known use if the live chain
  // reports less free-quota usage than our receipts imply.
  const scale=knownNow>measuredUsed&&knownNow>0?measuredUsed/knownNow:1;
  const unknown=Math.max(0,measuredUsed-knownNow);
  const used=known.reduce((n,s)=>n+scale*remaining(s.points,s.at,at),0)
    +remaining(unknown,observedAt,at)
    +spends.filter(s=>s.at>observedAt&&s.at<=at).reduce((n,s)=>n+remaining(s.points,s.at,at),0);
  return Math.max(0,Math.min(limit,limit-Math.ceil(used)));
}

// After the most recent modeled spend, recovery is monotonic. Find when the
// forecast crosses the floor, then add an hour if recovery was needed.
export function bufferedReadyAt(limit:number,available:number,observedAt:number,after:number,
  target=MIN_FREE_BANDWIDTH,spends:ForecastSpend[]=[]):number|null{
  if(limit<target)return null;
  const lastSpend=spends.length?Math.max(...spends.map(s=>s.at)):observedAt;
  const start=Math.max(observedAt,lastSpend);
  if(projectedFree(limit,available,observedAt,start,spends)>=target)return Math.max(start,after);
  let low=start,high=start+RECOVERY_WINDOW_MS;
  if(projectedFree(limit,available,observedAt,high,spends)<target)return null;
  while(high-low>1000){
    const mid=Math.floor((low+high)/2);
    if(projectedFree(limit,available,observedAt,mid,spends)>=target)high=mid;
    else low=mid;
  }
  return Math.max(after,high+RECOVERY_BUFFER_MS);
}
