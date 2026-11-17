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

test('recent feeding presets are distinct, newest first, and skip future or hospital entries',()=>{
 const {recentFeedings}=require('../service.js');
 const records=[
  {id:'a',type:'feeding',date:'2026-11-02T09:00',category:'분유',amount:'120ml'},
  {id:'b',type:'feeding',date:'2026-11-02T12:00',category:'분유',amount:'120ml '},
  {id:'c',type:'feeding',date:'2026-11-02T11:00',category:'모유',amount:'15분'},
  {id:'d',type:'feeding',date:'2026-11-02T18:00',category:'분유',amount:'200ml'},
  {id:'e',type:'hospital',date:'2026-11-02T13:00',hospital:'솜소아과',reason:'예방접종'},
  {id:'f',type:'feeding',date:'2026-11-01T08:00',category:'혼합',amount:'90ml'},
  {id:'g',type:'feeding',date:'2026-10-31T08:00',category:'분유',amount:'60ml'}];
 assert.deepEqual(recentFeedings(records,3,now),[
  {category:'분유',amount:'120ml'},{category:'모유',amount:'15분'},{category:'혼합',amount:'90ml'}]);
 assert.deepEqual(recentFeedings([],3,now),[]);
});

test('feeding amounts need a volume or duration unit to become presets',()=>{
 const {hasFeedingUnit,recentFeedings}=require('../service.js');
 for(const ok of ['120ml','120 ml','80cc','90 미리','15분','1.5시간'])assert.equal(hasFeedingUnit(ok),true,ok);
 for(const bad of ['1','2','조금','분','120ml 정도'])assert.equal(hasFeedingUnit(bad),false,bad);
 const records=[
  {id:'a',type:'feeding',date:'2026-11-02T12:00',category:'모유',amount:'2'},
  {id:'b',type:'feeding',date:'2026-11-02T11:00',category:'모유',amount:'15분'}];
 assert.deepEqual(recentFeedings(records,3,now),[{category:'모유',amount:'15분'}]);
});

test('period summaries cover today, yesterday, this week and last week (Sunday start) without future entries',()=>{
 const {periodSummaries,weekStart,monthGrid,rangeSummary}=require('../service.js');
 const now=new Date(2026,10,17,15,0); // Tuesday
 assert.equal(weekStart('2026-11-17'),'2026-11-15');assert.equal(weekStart('2026-11-15'),'2026-11-15');assert.equal(weekStart('2026-11-01'),'2026-11-01');
 const f=(date,amount,category='분유')=>({id:date+amount,type:'feeding',date,category,amount});
 const records=[f('2026-11-17T07:12','100ml'),f('2026-11-17T13:18','15분','모유'),f('2026-11-17T18:00','90ml'),
  f('2026-11-16T09:00','120ml'),f('2026-11-15T09:00','80cc'),f('2026-11-14T09:00','60ml'),f('2026-11-08T09:00','50ml'),
  f('2026-11-17T08:00','2'),{id:'h',type:'hospital',date:'2026-11-17T09:00',hospital:'x',reason:'y'}];
 const [today,yesterday,week,last]=periodSummaries(records,now);
 assert.deepEqual([today.count,today.volume,today.minutes,today.measuredCount,today.timedCount],[3,100,15,1,1]);
 assert.deepEqual([yesterday.from,yesterday.count,yesterday.volume],['2026-11-16',1,120]);
 assert.deepEqual([week.from,week.to,week.count,week.volume],['2026-11-15','2026-11-17',5,300]);
 assert.deepEqual([last.from,last.to,last.count,last.volume],['2026-11-08','2026-11-14',2,110]);
 const grid=monthGrid(records,2026,11,now);
 assert.equal(grid.length%7,0);assert.equal(grid[0].date,'2026-11-01');
 const day17=grid.find(c=>c&&c.day===17),day18=grid.find(c=>c&&c.day===18);
 assert.deepEqual([day17.count,day17.volume,day17.future],[3,100,false]);
 assert.deepEqual([day18.count,day18.future],[0,true]);
 const feb=monthGrid([],2027,2,now);assert.equal(feb.filter(Boolean).length,28);assert.equal(feb.slice(0,1)[0],null);
 assert.equal(rangeSummary(records,'2026-12-01','2026-12-31',now).count,0);
});

test('month grid counts schedules and only pending dated shopping per day',()=>{
 const {monthGrid}=require('../service.js');
 const now=new Date(2026,10,17,15,0);
 const schedule=[{id:'1',date:'2026-11-20T19:00',title:'약속',who:'아빠'},{id:'2',date:'2026-11-20T08:00',title:'병원'},{id:'3',date:'2026-12-01T08:00',title:'다음달'}];
 const shopping=[{id:'a',title:'기저귀',quantity:'1',date:'2026-11-20',done:'no'},{id:'b',title:'분유',quantity:'1',date:'2026-11-20',done:'yes'},{id:'c',title:'물티슈',quantity:'1',done:'no'}];
 const grid=monthGrid([],2026,11,now,schedule,shopping);
 const day20=grid.find(c=>c&&c.day===20);
 assert.deepEqual([day20.schedule,day20.shopping,day20.count,day20.future],[2,1,0,true]);
 assert.equal(grid.filter(Boolean).reduce((n,c)=>n+c.schedule+c.shopping,0),3);
 assert.equal(monthGrid([],2026,11,now).find(c=>c&&c.day===20).schedule,0);
});
