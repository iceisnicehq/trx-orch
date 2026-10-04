export type ReportOptions={address:string;variantId?:string;campaignId?:string;csv?:boolean;includePrehistory?:boolean};

export function reportUrl({address,variantId,campaignId,csv,includePrehistory}:ReportOptions){
  const path=variantId?`/api/plans/${encodeURIComponent(variantId)}/report/${encodeURIComponent(address)}`:
    `/api/campaign/report/${encodeURIComponent(address)}`;
  const query=new URLSearchParams();
  if(csv)query.set('format','csv');
  if(campaignId&&!variantId)query.set('campaignId',campaignId);
  if(includePrehistory)query.set('includePrehistory','1');
  return path+(query.size?'?'+query.toString():'');
}

export function historyPreference(kind:'graph'|'csv'){
  try{return localStorage.getItem(`trx.report.prehistory.${kind}`)==='1';}catch{return false;}
}
export function saveHistoryPreference(kind:'graph'|'csv',enabled:boolean){
  try{localStorage.setItem(`trx.report.prehistory.${kind}`,enabled?'1':'0');}catch{/* Optional browser preference. */}
}
