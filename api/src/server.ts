import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {timingSafeEqual} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {loadConfig,MODE,TARGET} from './config.js';
import {TronService} from './tron.js';
import {EngineService,HttpError} from './engine.js';
import {TelegramService,telegramOptionsFromEnv} from './telegram.js';
import {nodeHistory} from './node-history.js';

const config=await loadConfig();
const db=new PrismaClient();
const tron=new TronService(db,config);
const engine=new EngineService(db,tron,config);
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
app.get('/api/health',(_req,res)=>res.json({ok:true,mode:MODE}));
app.get('/api/state',asyncRoute(async(_req,res)=>{
  const [s,wallets,paid]=await Promise.all([db.engineState.findUniqueOrThrow({where:{id:1}}),db.wallet.findMany({orderBy:{ordinal:'asc'}}),db.transfer.aggregate({where:{kind:'PAYOUT',status:'CONFIRMED'},_sum:{amountSun:true}})]);
  const snapshot=await tron.publicWallets(wallets);
  const balances=wallets.map((w,i)=>({address:w.address,ordinal:w.ordinal,autoApprove:w.autoApprove,mixEnabled:w.mixEnabled,joined:w.joined,
    reserveSun:w.joined?w.entryBalanceSun!-TARGET:Math.max(0,snapshot[i].balanceSun-TARGET),balanceSun:snapshot[i].balanceSun,bandwidth:snapshot[i].bandwidth}));
  const members=balances.filter(w=>s.phase==='IDLE'?w.mixEnabled:w.joined);
  const reserveSun=members.reduce((n,w)=>n+w.reserveSun,0);
  const rebalanceRows=s.rebalanceFromSequence===null?[]:await db.transfer.findMany({
    where:{kind:'REBALANCE',sequence:{gte:s.rebalanceFromSequence}},select:{status:true}});
  res.json({mode:MODE,phase:s.phase,status:`Status: ${s.status}`,fatalReason:s.fatalReason,teacherAddress:config.teacherAddress,
    expectedPoolSun:members.length*TARGET-(paid._sum.amountSun??0),poolSun:members.reduce((n,w)=>n+w.balanceSun,0)-reserveSun,
    reserveSun,configuredSun:balances.reduce((n,w)=>n+w.balanceSun,0),selectedCount:balances.filter(w=>w.mixEnabled).length,joinedCount:balances.filter(w=>w.joined).length,
    mixAmountMode:s.mixAmountMode,mixAmountListSun:JSON.parse(s.mixAmountList),mixAmountCursor:s.mixAmountCursor,
    rebalanceTotal:rebalanceRows.length,rebalanceDone:rebalanceRows.filter(r=>r.status==='CONFIRMED').length,
    wallets:balances,updatedAt:s.updatedAt});
}));
app.get('/api/graph',asyncRoute(async(_req,res)=>{
  const [transfers,wallets,s]=await Promise.all([
    db.transfer.findMany({orderBy:{sequence:'asc'},select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,scheduledAt:true,createdAt:true,txId:true,note:true,bandwidthUsed:true}}),
    db.wallet.findMany({orderBy:{ordinal:'asc'}}),db.engineState.findUniqueOrThrow({where:{id:1}})
  ]);
  res.json({nodes:[...wallets.map(w=>({id:w.address,label:`Node ${w.ordinal+1}`,mixEnabled:w.mixEnabled,joined:w.joined})),{id:config.teacherAddress,label:'Teacher',mixEnabled:false,joined:false}],
    currentMapFromSequence:['REBALANCE_REQUESTED','REBALANCING'].includes(s.phase)?s.rebalanceFromSequence:
      ['END_REQUESTED','SETTLING'].includes(s.phase)?s.settlementFromSequence:null,
    edges:transfers.filter(t=>t.status!=='CANCELLED')});
}));
app.get('/api/rebalance/preview',asyncRoute(async(_req,res)=>res.json(await engine.rebalancePreview())));
app.get('/api/queue',asyncRoute(async(_req,res)=>{
  const rows=await db.transfer.findMany({where:{status:{in:['PLANNED','APPROVED','PAUSED','SUBMITTED','SUBMITTING','UNKNOWN']}},orderBy:{sequence:'asc'},select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,scheduledAt:true,note:true,txId:true}});
  res.json(rows);
}));
app.get('/api/history/:address',asyncRoute(async(req,res)=>{
  const address=req.params.address;
  if(!config.wallets.some(w=>w.address===address)&&address!==config.teacherAddress)throw new HttpError(404,'Unknown node');
  const before=req.query.before===undefined?undefined:z.coerce.number().int().positive().safe().parse(req.query.before);
  res.json(await nodeHistory(db,address,before));
}));
app.get('/api/logs/:address',asyncRoute(async(req,res)=>{
  const address=req.params.address;
  if(address!=='all'&&!config.wallets.some(w=>w.address===address)&&address!==config.teacherAddress)throw new HttpError(404,'Unknown node');
  const page=z.coerce.number().int().min(0).max(100000).parse(req.query.page??0);
  const [events,transfers]=await Promise.all([
    db.audit.findMany({orderBy:{id:'desc'},take:100,skip:page*100,where:address==='all'?{}:{detail:{contains:address}}}),
    db.transfer.findMany({where:address==='all'?{}:{OR:[{from:address},{to:address}]},orderBy:{sequence:'desc'},take:100,skip:page*100,select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,txId:true,note:true,bandwidthUsed:true,confirmedAt:true,scheduledAt:true,updatedAt:true}})
  ]);
  res.json({events,transfers});
}));
app.post('/api/admin/start',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.start())));
app.post('/api/admin/replan',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.replan())));
app.post('/api/admin/rebalance',requirePassword,asyncRoute(async(_req,res)=>res.json(await engine.rebalance())));
app.post('/api/admin/mix-amounts',requirePassword,asyncRoute(async(req,res)=>{
  const body=z.object({mode:z.enum(['RANDOM','LIST']),amountsSun:z.array(z.union([z.literal(500_000),z.literal(1_000_000)])).min(1).max(64).optional()}).parse(req.body);
  res.json(await engine.setMixAmounts(body.mode,body.amountsSun));
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
