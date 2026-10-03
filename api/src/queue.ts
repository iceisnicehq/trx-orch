/** The complete campaign lives in Transfer, but the approval desk/pinned
 * message shows only the nearest remaining row per campaign sender. */
export function approvalQueue<T extends {campaignId:string|null;from:string;sequence:number}>(rows:T[]):T[]{
  const seen=new Set<string>();
  return [...rows].sort((a,b)=>a.sequence-b.sequence).filter(row=>{
    if(!row.campaignId)return true;
    const key=`${row.campaignId}:${row.from}`;
    if(seen.has(key))return false;seen.add(key);return true;
  });
}
