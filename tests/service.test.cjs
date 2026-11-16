const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summary,filter,localDateTime}=require('../service.js');
const now=new Date(2026,10,2,15,0);
const items=[{id:'1',type:'feeding',date:'2026-11-02T10:00',amount:'80ml',memo:'분유'}, {id:'2',type:'feeding',date:'2026-11-02T11:00',amount:'15분'}, {id:'3',type:'feeding',date:'2026-11-02T12:00',amount:'80'}, {id:'4',type:'hospital',date:'2026-11-02T13:00',amount:'200ml'}, {id:'5',type:'feeding',date:'2026-11-01T23:00',amount:'100ml'}];
test('volume counts explicit ml only, not minutes, bare values or hospital records',()=>{const s=summary(items,now);assert.equal(s.count,3);assert.equal(s.volume,80);assert.equal(s.measuredCount,1);assert.equal(s.latest,'2026-11-02T12:00')});
test('local dates do not drift to UTC',()=>assert.equal(localDateTime(now),'2026-11-02T15:00'));
test('empty summary is defined',()=>assert.deepEqual(summary([],now),{count:0,volume:0,measuredCount:0,latest:null}));
test('future feeding is not reported as latest',()=>assert.equal(summary([{type:'feeding',date:'2026-11-03T10:00',amount:'80ml'}],now).latest,null));
test('date interval is inclusive with record kind and memo search',()=>assert.deepEqual(filter(items,{from:'2026-11-02',to:'2026-11-02',type:'feeding',query:'분유'}).map(x=>x.id),['1']));
test('missing completion state is pending for old backups',()=>assert.deepEqual(filter([{id:'1'},{id:'2',done:'yes'}],{status:'pending'}),[{id:'1'}]));
test('daily feeding includes empty days and keeps times and volumes distinct',()=>{
 const {dailyFeeding}=require('../service.js');
 assert.deepEqual(dailyFeeding(items,3,now),[
  {date:'2026-10-31',count:0,volume:0,measuredCount:0},
  {date:'2026-11-01',count:1,volume:100,measuredCount:1},
  {date:'2026-11-02',count:3,volume:80,measuredCount:1}
 ]);
});

test('volume unit aliases agree in summaries and daily statistics',()=>{
 const {feedingVolume,dailyFeeding}=require('../service.js');
 for(const unit of ['ml','mL','밀리리터','밀리 리터','미리','cc','씨씨']){
  assert.equal(feedingVolume('120'+unit),120);
  const record={type:'feeding',date:'2026-11-02T10:00',amount:'120'+unit};
  assert.equal(summary([record],now).volume,120);
  assert.equal(dailyFeeding([record],1,now)[0].volume,120);
 }
 for(const amount of ['15분','120','120mg'])assert.equal(feedingVolume(amount),null);
});
