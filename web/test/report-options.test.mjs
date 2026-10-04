import {test} from 'node:test';
import {strictEqual,ok} from 'node:assert';
import {reportUrl} from '../src/report-options.ts';

test('graph and CSV history choices are independent for current and archived reports',()=>{
  strictEqual(reportUrl({address:'TA',includePrehistory:true}),'/api/campaign/report/TA?includePrehistory=1');
  strictEqual(reportUrl({address:'TA',campaignId:'old',csv:true}),'/api/campaign/report/TA?format=csv&campaignId=old');
  strictEqual(reportUrl({address:'TA',campaignId:'old',csv:true,includePrehistory:true}),'/api/campaign/report/TA?format=csv&campaignId=old&includePrehistory=1');
});

test('saved-plan downloads use the variant route and do not accidentally select a campaign',()=>{
  const url=reportUrl({address:'TA',variantId:'saved',campaignId:'irrelevant',csv:true,includePrehistory:true});
  strictEqual(url,'/api/plans/saved/report/TA?format=csv&includePrehistory=1');
  ok(!url.includes('campaignId'));
});

test('report routes encode identifiers and leave default history disabled',()=>{
  strictEqual(reportUrl({address:'A/B',variantId:'v?id'}),'/api/plans/v%3Fid/report/A%2FB');
  ok(!reportUrl({address:'TA'}).includes('includePrehistory'));
});
