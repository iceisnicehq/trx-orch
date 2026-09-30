import type {PrismaClient,Prisma} from '@prisma/client';

const PAGE_SIZE=50;

/** Transfer history is cursor-paged so long-running games remain readable. */
export async function nodeHistory(db:PrismaClient,address:string,before?:number){
  const participant:Prisma.TransferWhereInput={OR:[{from:address},{to:address}]};
  const where:Prisma.TransferWhereInput={...participant,...(before===undefined?{}:{sequence:{lt:before}})};
  const [total,rows]=await Promise.all([
    db.transfer.count({where:participant}),
    db.transfer.findMany({where,orderBy:{sequence:'desc'},take:PAGE_SIZE+1,
      select:{id:true,sequence:true,kind:true,status:true,from:true,to:true,amountSun:true,
        createdAt:true,scheduledAt:true,confirmedAt:true,updatedAt:true,txId:true,bandwidthUsed:true,note:true}})
  ]);
  const items=rows.slice(0,PAGE_SIZE);
  return {address,total,items,nextBefore:rows.length>PAGE_SIZE?items[items.length-1].sequence:null};
}
