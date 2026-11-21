const {test}=require('node:test');
const assert=require('node:assert/strict');
const {browser,blank}=require('./helpers/browser.cjs');

test('the stats tab shows usual feeding times and turns the Calendar alarm on and off',async()=>{
 const status=enabled=>({auth_state:'ready',services:{},review:0,errors:[],feeding_alarm:{enabled,slots:[{time:'03:15',days:6},{time:'14:05',days:7}],next:enabled?'2026-11-21T14:35':null,usual:enabled?'14:05':null}});
 const server={data:blank(),imported:new Set(),failure:null,readGate:null,googleStatus:status(false)};
 const b=browser({session:{base:'http://127.0.0.1:8787',token:'existing',username:'mom'},server});
 const base=b.context.fetch,sent=[];
 b.context.fetch=async(url,options)=>{
  if(url.endsWith('/api/feeding-alarm')){const body=JSON.parse(options.body);sent.push(body);server.googleStatus=status(body.enabled);
   return {ok:true,json:async()=>({data:blank(),settings:{children:[],feedingAlarm:body.enabled},sources:{},google_status:server.googleStatus})};}
  if(url.endsWith('/api/ai'))return {ok:true,json:async()=>({enabled:false,homeOnly:true,providers:[]})};
  return base(url,options);
 };
 await b.settle();
 const open=async page=>{b.context.location.hash='#'+page;b.events.get('hashchange')();await b.settle();};
 await open('stats');
 // Folded to one line until opened.
 let html=b.get('#content').innerHTML;
 assert.match(html,/<strong>⏰ 알람<\/strong><span class="caption">밥 꺼짐<\/span>/);
 assert.doesNotMatch(html,/data-alarm-kind/);
 await b.events.get('click')({target:{closest:sel=>sel==='a'?null:{dataset:{alarmOpen:'1'}}}});
 html=b.get('#content').innerHTML;
 assert.match(html,/🍼 밥 알람/);
 assert.match(html,/<span class="badge">03:15 <small>6일<\/small><\/span> <span class="badge">14:05 <small>7일<\/small><\/span>/);
 assert.match(html,/꺼져 있어요/);
 await b.events.get('click')({target:{closest:sel=>sel==='a'?null:{dataset:{alarmKind:'feeding',alarm:'on'}}}});
 assert.deepEqual(sent,[{kind:'feeding',enabled:true}]);
 html=b.get('#content').innerHTML;
 assert.match(html,/다음 알람: <strong>2026-11-21 14:35<\/strong> \(평소 14:05에 먹는데 기록이 없으면\)/);
 assert.match(html,/data-alarm-kind="feeding" data-alarm="off">밥 알람 끄기/);
 assert.match(b.get('#connection-status').textContent,/밥 알람을 켰어요/);
 await open('home');
 assert.match(b.get('#content').innerHTML,/⏰ 밥 알람 (11\/21 )?14:35 \(평소 14:05\)/);
 await open('stats');
 await b.events.get('click')({target:{closest:sel=>sel==='a'?null:{dataset:{alarmKind:'feeding',alarm:'off'}}}});
 assert.deepEqual(sent.at(-1),{kind:'feeding',enabled:false});
 assert.match(b.get('#content').innerHTML,/꺼져 있어요/);
});

test('no alarm card without Google Calendar or for the guest',async()=>{
 let b=browser({session:{base:'http://127.0.0.1:8787',token:'existing',username:'mom'}});
 await b.settle();b.context.location.hash='#stats';b.events.get('hashchange')();await b.settle();
 assert.doesNotMatch(b.get('#content').innerHTML,/밥 알람/);
 const server={data:blank(),imported:new Set(),failure:null,readGate:null,readOnly:true,googleStatus:{feeding_alarm:{enabled:false,slots:[],next:null,usual:null}}};
 b=browser({session:{base:'http://127.0.0.1:8787',token:'existing',username:'guest'},server});
 await b.settle();b.context.location.hash='#stats';b.events.get('hashchange')();await b.settle();
 assert.doesNotMatch(b.get('#content').innerHTML,/밥 알람/);
});

test('the nap alarm shows the usual wake window and switches on with its own kind',async()=>{
 const status={auth_state:'ready',services:{},review:0,errors:[],feeding_alarm:{enabled:false,slots:[],next:null,usual:null},nap_alarm:{enabled:false,usual_minutes:null,samples:2,next:null}};
 const server={data:blank(),imported:new Set(),failure:null,readGate:null,googleStatus:status};
 const b=browser({session:{base:'http://127.0.0.1:8787',token:'existing',username:'mom'},server});
 const base=b.context.fetch,sent=[];
 b.context.fetch=async(url,options)=>{
  if(url.endsWith('/api/feeding-alarm')){const body=JSON.parse(options.body);sent.push(body);server.googleStatus={...status,nap_alarm:{enabled:body.enabled,usual_minutes:110,samples:12,next:'2026-11-21T12:50'}};
   return {ok:true,json:async()=>({data:blank(),settings:{children:[],napAlarm:body.enabled},google_status:server.googleStatus})};}
  return base(url,options);
 };
 await b.settle();b.context.location.hash='#stats';b.events.get('hashchange')();await b.settle();
 assert.match(b.get('#content').innerHTML,/밥 꺼짐 · 낮잠 꺼짐/);
 await b.events.get('click')({target:{closest:sel=>sel==='a'?null:{dataset:{alarmOpen:'1'}}}});
 assert.match(b.get('#content').innerHTML,/낮에 깬 뒤 다시 잠든 기록이 3번 더 있으면/);
 await b.events.get('click')({target:{closest:sel=>sel==='a'?null:{dataset:{alarmKind:'nap',alarm:'on'}}}});
 assert.deepEqual(sent,[{kind:'nap',enabled:true}]);
 const html=b.get('#content').innerHTML;
 assert.match(html,/보통 <strong>1시간 50분<\/strong> 지나 잠들었어요 \(12번\)\. 다음 알람: <strong>2026-11-21 12:50<\/strong>/);
 assert.match(html,/data-alarm-kind="nap" data-alarm="off">낮잠 알람 끄기/);
});
