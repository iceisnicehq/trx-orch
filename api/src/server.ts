import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {timingSafeEqual} from 'node:crypto';
import {createDatabase} from './database.js';
import {z} from 'zod';
import {loadConfig,MODE,TARGET} from './config.js';
import {TronService} from './tron.js';
import {EngineService,HttpError} from './engine.js';
import {TelegramService,telegramOptionsFromEnv} from './telegram.js';
import {nodeHistory} from './node-history.js';
import {campaignSummary,ownerReport,reportCsv,variantOwnerReport} from './campaign-report.js';
import {selectedDraft,variantList} from './plan-variants.js';
import {approvalQueue} from './queue.js';

const config=await loadConfig();
const db=createDatabase();
const tron=new TronService(db,config);
const engine=new EngineService(db,tron,config,true);
const telegram=new TelegramService(db,telegramOptionsFromEnv());
await telegram.bootstrap();
await engine.init();
telegram.start();
const app=express();app.disable('x-powered-by');
// Nginx is the one proxy hop and replaces X-Forwarded-For with its client IP.
app.set('trust proxy',1);
app.use(helmet());app.use(express.json({limit:'8kb'}));
app.use('/api/admin',rateLimit({windowMs:60_000,limit:30,standardHeaders:'draft-7',legacyHeaders:false}));
const PASSWORD=process.env.ADMIN_PASSWORD?.length?process.env.ADMIN_PASSWORD:'P@ssw0rd12344321';
function requirePassword(req:express.Request,res:express.Response,next:express.NextFunction){
  const input=req.body?.password;
  const a=Buffer.from(typeof input==='string'?input:'');const b=Buffer.from(PASSWORD);
  if(a.length!==b.length||!timingSafeEqual(a,b)){res.status(401).json({error:'Invalid password'});return;}
  next();
}
const asyncRoute=(fn:(req:express.Request,res:express.Response)=>Promise<unknown>)=>(req:express.Request,res:express.Response,next:express.NextFunction)=>{Promise.resolve(fn(req,res)).catch(next);};
async function knownNode(address:string){
  return config.wallets.some(w=>w.address===address)||address===config.teacherAddress||Boolean(await db.transfer.findFirst({where:{kind:'PAYOUT',to:address,status:'CONFIRMED'},select:{id:true}}));
}
app.get('/api/health',(_req,res)=>res.json({ok:true,mode:MODE}));
app.get('/api/state',asyncRoute(async(_req,res)=>{
  const [s,wallets,paid]=await Promise.all([db.engineState.findUniqueOrThrow({where:{id:1}}),db.wallet.findMany({orderBy:{ordinal:'asc'}}),db.transfer.aggregate({where:{kind:'PAYOUT',status:'CONFIRMED'},_sum:{amountSun:true}})]);
  const snapshot=await tron.publicWallets(wallets);
  const balances=wallets.map((w,i)=>({address:w.address,ordinal:w.ordinal,autoApprove:w.autoApprove,mixEnabled:w.mixEnabled,joined:w.joined,
    reserveSun:w.joined?w.entryBalanceSun!-TARGET:Math.max(0,snapshot[i].balanceSun-TARGET),balanceSun:snapshot[i].balanceSun,bandwidth:snapshot[i].bandwidth}));
  const members=balances.filter(w=>['IDLE','PREPARING'].includes(s.phase)?w.mixEnabled:w.joined);
  const reserveSun=members.reduce((n,w)=>n+w.reserveSun,0);
  const rebalanceRows=s.rebalanceFromSequence===null?[]:await db.transfer.findMany({
    where:{kind:'REBALANCE',sequence:{gte:s.rebalanceFromSequence}},select:{status:true}});
  res.json({mode:MODE,phase:s.phase,status:`Status: ${s.status}`,fatalReason:s.fatalReason,teacherAddress:s.teacherAddress,
    expectedPoolSun:members.length*TARGET-(paid._sum.amountSun??0),poolSun:members.reduce((n,w)=>n+w.balanceSun,0)-reserveSun,
    reserveSun,configuredSun:balances.reduce((n,w)=>n+w.balanceSun,0),selectedCount:balances.filter(w=>w.mixEnabled).length,joinedCount:balances.filter(w=>w.joined).length,
    mixAmountMode:s.mixAmountMode,mixAmountListSun:JSON.parse(s.mixAmountList),mixAmountCursor:s.mixAmountCursor,activeCampaignId:s.activeCampaignId,selectedPlanVariantId:s.selectedPlanVariantId,
    rebalanceTotal:rebalanceRows.length,rebalanceDone:rebalanceRows.filter(r=>r.status==='CONFIRMED').length,
    wallets:balances,updatedAt:s.updatedAt});
}));
app.get('/api/graph',asyncRoute(async(_req,res)=>{
  const [transfers,wallets,s]=await Promise.all([
    db.transfer.findMany({orderBy:{sequence:'asc'},select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,scheduledAt:true,createdAt:true,txId:true,note:true,bandwidthUsed:true,campaignId:true,campaignDay:true}}),
    db.wallet.findMany({orderBy:{ordinal:'asc'}}),db.engineState.findUniqueOrThrow({where:{id:1}})
  ]);
  const draft=await selectedDraft(db);
  const graphRows=[...transfers,...(draft?.rows??[])];
  const oldTeachers=[...new Set(transfers.filter(t=>t.kind==='PAYOUT'&&t.to!==s.teacherAddress).map(t=>t.to))];
  const returning=transfers.find(t=>t.campaignId===s.activeCampaignId&&t.kind==='RETURN'&&t.status!=='CANCELLED');
  res.json({nodes:[...wallets.map(w=>({id:w.address,label:`Node ${w.ordinal+1}`,mixEnabled:w.mixEnabled,joined:w.joined})),{id:s.teacherAddress,label:'Teacher',mixEnabled:false,joined:false},
      ...oldTeachers.map(id=>({id,label:'Teacher (previous)',mixEnabled:false,joined:false}))],
    currentMapFromSequence:s.phase.startsWith('CAMPAIGN_RETURN')?returning?.sequence??null:['REBALANCE_REQUESTED','REBALANCING'].includes(s.phase)?s.rebalanceFromSequence:
      ['END_REQUESTED','SETTLING'].includes(s.phase)?s.settlementFromSequence:null,
    edges:graphRows.filter(t=>t.status!=='CANCELLED')});
}));
app.get('/api/rebalance/preview',asyncRoute(async(_req,res)=>res.json(await engine.rebalancePreview())));
app.get('/api/recovery/preview',asyncRoute(async(_req,res)=>res.json(await engine.extraRecoveryPreview())));
app.get('/api/queue',asyncRoute(async(_req,res)=>{
  const rows=await db.transfer.findMany({where:{status:{in:['PLANNED','APPROVED','PAUSED','SUBMITTED','SUBMITTING','UNKNOWN']}},orderBy:{sequence:'asc'},select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,scheduledAt:true,note:true,txId:true,campaignId:true,campaignDay:true}});
  const draft=await selectedDraft(db);
  res.json(approvalQueue([...rows,...(draft?.rows??[])]));
}));
app.get('/api/plans',asyncRoute(async(_req,res)=>res.json(await variantList(db))));
app.get('/api/plans/:id/report/:address',asyncRoute(async(req,res)=>{
  const variant=await db.planVariant.findUnique({where:{id:req.params.id}});
  if(!variant)throw new HttpError(404,'Saved plan not found');
  const report=variantOwnerReport(variant,req.params.address);
  if(!report)throw new HttpError(404,'Wallet not in this saved plan');
  if(req.query.format==='csv'){
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="plan-${variant.number}-node-${report.campaign.members.find(m=>m.address===report.address)!.ordinal+1}.csv"`);
    res.send(reportCsv(report));return;
  }
  res.json(report);
}));
app.get('/api/campaign',asyncRoute(async(_req,res)=>res.json(await campaignSummary(db))));
app.get('/api/campaigns',asyncRoute(async(_req,res)=>res.json(await db.campaign.findMany({orderBy:{createdAt:'desc'},select:{id:true,status:true,startedAt:true,deadlineAt:true,totalDays:true}}))));
app.get('/api/campaign/return/preview',asyncRoute(async(_req,res)=>res.json(await engine.campaignReturnPreview())));
app.get('/api/campaign/report/:address',asyncRoute(async(req,res)=>{
  const id=req.query.campaignId===undefined?undefined:z.string().min(1).max(100).parse(req.query.campaignId);
  const report=await ownerReport(db,req.params.address,id);
  if(!report)throw new HttpError(404,'This wallet has no attributed stake in the selected campaign');
  if(req.query.format==='csv'){
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="node-${report.campaign.members.find(m=>m.address===report.address)!.ordinal+1}-${report.campaign.id}.csv"`);
    res.send(reportCsv(report));return;
  }
  res.json(report);
}));
app.get('/api/history/:address',asyncRoute(async(req,res)=>{
  const address=req.params.address;
  if(!await knownNode(address))throw new HttpError(404,'Unknown node');
  const before=req.query.before===undefined?undefined:z.coerce.number().int().positive().safe().parse(req.query.before);
  const status=z.enum(['ALL','CONFIRMED']).parse(req.query.status??'ALL');
  res.json(await nodeHistory(db,address,before,status));
}));
app.get('/api/logs/:address',asyncRoute(async(req,res)=>{
  const address=req.params.address;
  if(address!=='all'&&!await knownNode(address))throw new HttpError(404,'Unknown node');
  const page=z.coerce.number().int().min(0).max(100000).parse(req.query.page??0);
  const status=z.enum(['ALL','CONFIRMED']).parse(req.query.status??'ALL');
  const [events,transfers]=await Promise.all([
    db.audit.findMany({orderBy:{id:'desc'},take:100,skip:page*100,where:address==='all'?{}:{detail:{contains:address}}}),
    db.transfer.findMany({where:{...(address==='all'?{}:{OR:[{from:address},{to:address}]}),
      ...(status==='CONFIRMED'?{status:'CONFIRMED'}:{})},orderBy:{sequence:'desc'},take:100,skip:page*100,select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,txId:true,note:true,bandwidthUsed:true,confirmedAt:true,scheduledAt:true,updatedAt:true}})
  ]);
  res.json({events,transfers});
}));
app.post('/api/admin/plans/generate',requirePassword,asyncRoute(async(req,res)=>{
  const b=z.object({totalDays:z.number().int().min(18).max(60).optional(),deadlineAt:z.string().datetime({offset:true}).optional()}).parse(req.body);
  res.json(await engine.generatePlan({totalDays:b.totalDays,deadlineAt:b.deadlineAt?new Date(b.deadlineAt):undefined}));
}));
app.post('/api/admin/plans/current',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.prepareCurrent())));
app.post('/api/admin/plans/:id/select',requirePassword,asyncRoute(async(req,res)=>res.json(await engine.selectPlan(req.params.id))));
app.post('/api/admin/plans/:id/swap',requirePassword,asyncRoute(async(req,res)=>{
  const b=z.object({first:z.string(),second:z.string()}).parse(req.body);
  res.json(await engine.swapPlans(req.params.id,b.first,b.second));
}));
app.post('/api/admin/start',requirePassword,asyncRoute(async(req,res)=>{
  const body=z.object({totalDays:z.number().int().min(18).max(60).optional(),deadlineAt:z.string().datetime({offset:true}).optional()}).parse(req.body);
  res.json(await engine.startCampaign({totalDays:body.totalDays,deadlineAt:body.deadlineAt?new Date(body.deadlineAt):undefined}));
}));
app.post('/api/admin/teacher',requirePassword,asyncRoute(async(req,res)=>{
  res.json(await engine.changeTeacher(z.string().trim().parse(req.body.address)));
}));
app.post('/api/admin/campaign/return',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.returnCampaign())));
app.post('/api/admin/replan',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.replan())));
app.post('/api/admin/rebalance',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.rebalance())));
app.post('/api/admin/resume',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.resumeExtraReserves())));
// Keep the existing route for dashboards installed before this change.
app.post('/api/admin/resume-excess',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.resumeExtraReserves())));
app.post('/api/admin/mix-amounts',requirePassword,asyncRoute(async(req,res)=>{
  throw new HttpError(410,'RANDOM/LIST are retired. Restore the old pool and Start the complete smart campaign.');
}));
app.post('/api/admin/end',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.end())));
app.post('/api/admin/queue/:id/approve',requirePassword,asyncRoute(async(req,res)=>res.json(await engine.approve(req.params.id))));
app.post('/api/admin/wallets/:address/autoapprove',requirePassword,asyncRoute(async(req,res)=>{
  const enabled=z.boolean().parse(req.body.enabled);
  res.json(await engine.autoApprove(req.params.address,enabled));
}));
app.post('/api/admin/wallets/:address/mix-enabled',requirePassword,asyncRoute(async(req,res)=>{
  const enabled=z.boolean().parse(req.body.enabled);
  res.json(await engine.setMixEnabled(req.params.address,enabled));
}));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(err instanceof z.ZodError){res.status(400).json({error:'Invalid request',issues:err.issues});return;}
  const code=err instanceof HttpError?err.code:500;
  if(code===500)console.error('API error:',err instanceof Error?err.message:String(err));
  res.status(code).json({error:code===500?'Internal server error':(err as Error).message});
});
app.listen(Number(process.env.PORT??3000),'0.0.0.0',()=>console.log(`API listening; ${config.wallets.length} participants; ${MODE} mode`));
