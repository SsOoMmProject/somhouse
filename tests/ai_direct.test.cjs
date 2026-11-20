const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const direct=require('../ai-direct.js');

function serve(routes){
 const calls=[];
 globalThis.fetch=async(url,options)=>{
  calls.push({url,options});
  const route=routes[url.split('?')[0]];
  if(!route)throw Error('unexpected '+url);
  const [status,body]=typeof route==='function'?route(options):route;
  return {ok:status<300,status,json:async()=>body};
 };
 return calls;
}

test('OpenAI: picks a current text model and reads the Responses output',async()=>{
 const calls=serve({
  'https://api.openai.com/v1/models':[200,{data:[
   {id:'gpt-5.6-terra',created:3},{id:'gpt-5.6-sol',created:4},{id:'gpt-5.5',created:2},{id:'gpt-realtime-2.1-mini',created:9},
   {id:'gpt-image-2',created:9},{id:'gpt-5.6-sol-2026-08-05',created:5},{id:'text-embedding-3-small',created:1},{id:'gpt-6-cyber',created:10},
  ]}],
  'https://api.openai.com/v1/responses':[200,{output:[{type:'reasoning',content:[]},{type:'message',content:[{type:'output_text',text:'안녕하세요'}]}]}],
 });
 const saved=await direct.connect('codex','sk-proj-'+'a'.repeat(40));
 assert.equal(saved.model,'gpt-5.6-sol');
 assert.deepEqual(saved.models,['gpt-5.6-sol','gpt-5.6-terra','gpt-5.5']);
 const result=await direct.ask('codex',saved,'안녕',null);
 assert.deepEqual(result,{answer:'안녕하세요',truncated:false});
 const body=JSON.parse(calls.at(-1).options.body);
 assert.equal(calls.at(-1).options.headers.Authorization,'Bearer '+saved.key);
 assert.equal(calls.at(-1).options.credentials,'omit');
 assert.deepEqual({model:body.model,store:body.store,instructions:body.instructions},{model:'gpt-5.6-sol',store:false,instructions:direct.SYSTEM});
 assert.deepEqual(JSON.parse(body.input),{question:'안녕'});
});

test('Gemini: prefers a stable Flash model and sends the key in a header, not the URL',async()=>{
 const calls=serve({
  'https://generativelanguage.googleapis.com/v1beta/models':[200,{models:[
   ...['gemini-3.1-pro-preview','gemini-4-carbon','gemini-3.1-flash-lite','gemini-3-flash-preview','gemini-3.6-flash','gemini-2.5-flash',
    'gemini-3.5-flash-lite','gemini-4-hydrogen','gemini-3.8-flash'].map(id=>({name:'models/'+id,supportedGenerationMethods:['generateContent']})),
   {name:'models/gemini-3.8-flash-image',supportedGenerationMethods:['generateContent']},
   {name:'models/gemini-embedding-2',supportedGenerationMethods:['embedContent']},
  ]}],
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent':[200,{candidates:[{content:{parts:[{text:'답'},{text:'변'}]}}]}],
 });
 const saved=await direct.connect('antigravity','AIza'+'b'.repeat(35));
 // Only free models, best first: top 2, middle 2, bottom 1. Paid, preview and retired ones are left out.
 assert.deepEqual(saved.models,['gemini-3.8-flash','gemini-4-hydrogen','gemini-3.6-flash','gemini-3.5-flash-lite','gemini-3.1-flash-lite']);
 assert.equal(saved.model,'gemini-3.8-flash');
 assert.equal(direct.GEMINI_TIER['gemini-3.1-flash-lite'],'하위');
 // If Google renames every free model, the account's own list still works.
 assert.deepEqual(direct.geminiShortlist(['gemini-9-flash','gemini-9-pro']),['gemini-9-flash','gemini-9-pro']);
 assert.equal((await direct.ask('antigravity',saved,'안녕',null)).answer,'답변');
 for(const call of calls){assert.doesNotMatch(call.url,/key=/);assert.equal(call.options.headers['x-goog-api-key'],saved.key);}
 const body=JSON.parse(calls.at(-1).options.body);
 assert.equal(body.systemInstruction.parts[0].text,direct.SYSTEM);
});

test('Claude: uses the current Opus with server-side fallbacks and reports refusals',async()=>{
 let reply=[200,{stop_reason:'end_turn',content:[{type:'text',text:'좋아요'}]}];
 const calls=serve({
  'https://api.anthropic.com/v1/models':[200,{data:[{id:'claude-sonnet-5-5'},{id:'claude-opus-5-5'}]}],
  'https://api.anthropic.com/v1/messages':()=>reply,
 });
 const saved=await direct.connect('claude','sk-ant-api03-'+'c'.repeat(40));
 assert.deepEqual(saved.models,['claude-opus-5-5','claude-sonnet-5-5']);
 assert.equal((await direct.ask('claude',saved,'안녕',null)).answer,'좋아요');
 const sent=calls.at(-1),body=JSON.parse(sent.options.body);
 assert.equal(sent.options.headers['anthropic-beta'],'server-side-fallback-2026-07-01');
 assert.deepEqual({model:body.model,fallbacks:body.fallbacks,effort:body.output_config.effort},{model:'claude-opus-5-5',fallbacks:'default',effort:'low'});
 assert.equal(body.thinking,undefined);
 reply=[200,{stop_reason:'refusal',content:[]}];
 await assert.rejects(direct.ask('claude',saved,'안녕',null),/답하지 않았어요/);
});

test('API errors become plain explanations',async()=>{
 const cases=[[401,{error:{message:'invalid x-api-key'}},/API 키가 올바르지 않아요/],[429,{error:{type:'rate_limit_error'}},/한도/],
  [400,{error:{message:'Your credit balance is too low'}},/크레딧/],[529,{error:{type:'overloaded_error'}},/잠시 후/],[404,{error:{message:'model: x'}},/다른 모델을 골라 주세요\. \(오류 404\)/],
  [503,{error:{code:503,message:'The model is overloaded. Please try again later.',status:'UNAVAILABLE'}},/요청이 몰려 있어요.*\(오류 503\)/],[500,{error:{message:'Internal error'}},/잠시 응답하지 않아요.*\(오류 500\)/]];
 for(const [status,body,message] of cases){
  serve({'https://api.anthropic.com/v1/messages':[status,body]});
  await assert.rejects(direct.ask('claude',{key:'k',model:'m'},'안녕',null),message);
 }
 globalThis.fetch=async()=>{throw TypeError('Failed to fetch');};
 await assert.rejects(direct.ask('claude',{key:'k',model:'m'},'안녕',null),/연결하지 못했어요/);
 await assert.rejects(direct.connect('claude',' 짧은 키 '),/Anthropic API 키를 확인해 주세요/);
});

test('record summaries match the numbers the Mac sends',()=>{
 const today='2026-11-20';
 const data={
  records:[
   {type:'feeding',date:'2026-11-20T08:00',amount:'80ml',memo:'x'},{type:'feeding',date:'2026-11-20T11:00',amount:'10분'},
   {type:'feeding',date:'2026-11-14T23:00',amount:'100 미리'},{type:'feeding',date:'2026-11-13T23:00',amount:'50ml'},
   {type:'sleep',date:'2026-11-19T10:00'},{type:'feeding',date:'2026-11-19T10:00',amount:'72.5ml'},
   {type:'sleep',date:'2026-11-19T23:30',end:'2026-11-20T01:15'},{type:'sleep',date:'2026-11-13T23:00',end:'2026-11-14T02:00'},
   {type:'sleep',date:'2026-11-20T13:00',end:'2026-11-20T12:00'},{type:'sleep',date:'2026-11-18T10:00',end:'2026-11-20T10:00'},
   {type:'sleep',date:'2026-02-30T10:00',end:'2026-03-01T10:00'},{type:'diaper',date:'2026-11-20T09:00',category:'둘 다'},
   {type:'diaper',date:'2026-11-20T10:00',category:'소변'},{type:'diaper',date:'2026-11-19T10:00',category:'대변'},{type:'diaper',date:'2026-11-10T10:00',category:'소변'},
  ],
  schedule:[{date:'2026-11-20'},{date:'2026-11-26T09:00'},{date:'2026-11-27'},{date:'2026-11-19'}],
  shopping:[{done:'yes'},{done:'no'},{}],
 };
 const script='import json,sys\nfrom datetime import date\nfrom ai import summarize_records\nd=json.load(sys.stdin)\n'
  +'print(json.dumps({s:summarize_records(s,d[{"feeding":"records","sleep":"records","diaper":"records"}.get(s,s)],date(2026,11,20)) for s in ("feeding","sleep","diaper","schedule","shopping")}))';
 const python=JSON.parse(execFileSync('python3',['-c',script],{cwd:path.resolve(__dirname,'..'),input:JSON.stringify(data)}));
 for(const scope of ['feeding','sleep','diaper','schedule','shopping'])assert.deepEqual(direct.summarize(scope,data,today),python[scope],scope);
 // Midnight-crossing sleeps split by day; open, backwards, over-24h and impossible-date sleeps are skipped.
 assert.deepEqual(python.sleep['2026-11-19'],{count:1,minutes:30});
 assert.deepEqual(python.sleep['2026-11-20'],{count:0,minutes:75});
 assert.deepEqual(python.sleep['2026-11-14'],{count:0,minutes:120});
 assert.deepEqual(python.diaper['2026-11-20'],{count:2,pee:2,poo:1});
 assert.equal(python.diaper['2026-11-10'],undefined);
});

test('follow-ups send only recent, short, text-only turns in each AI format',async()=>{
 const now=Date.parse('2026-11-21T06:00:00Z'),at=h=>new Date(now-h*3600000).toISOString();
 const log=[{q:'too old',a:'x',at:at(7)},...Array.from({length:6},(_,i)=>({q:'q'+i,a:'a'+i,ai:'Gemini',at:at(1)})),{q:'long',a:'가'.repeat(5000),at:at(0.5)},{q:'broken',at:at(0.1)}];
 const earlier=direct.history(log,now);
 assert.equal(earlier.length,direct.HISTORY_TURNS);
 assert.deepEqual(earlier.map(x=>x.q),['q2','q3','q4','q5','long']);
 assert.equal(earlier.at(-1).a.length,1500);
 assert.deepEqual(Object.keys(earlier[0]),['q','a']);
 assert.deepEqual(direct.history(null,now),[]);
 const two=[{q:'첫 질문',a:'첫 답'},{q:'둘째',a:'둘째 답'}];
 const records={scope:'feeding',summary:{}};
 let calls=serve({'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent':[200,{candidates:[{content:{parts:[{text:'ok'}]}}]}]});
 await direct.ask('antigravity',{key:'k',model:'m'},'그거 더 자세히',records,two);
 let body=JSON.parse(calls[0].options.body);
 assert.deepEqual(body.contents.map(x=>[x.role,x.parts[0].text]).slice(0,4),[['user','첫 질문'],['model','첫 답'],['user','둘째'],['model','둘째 답']]);
 // Record summaries go only with the new question.
 assert.deepEqual(JSON.parse(body.contents[4].parts[0].text),{question:'그거 더 자세히',records});
 calls=serve({'https://api.anthropic.com/v1/messages':[200,{stop_reason:'end_turn',content:[{type:'text',text:'ok'}]}]});
 await direct.ask('claude',{key:'k',model:'m'},'이어서',null,two);
 body=JSON.parse(calls[0].options.body);
 assert.deepEqual(body.messages.map(x=>x.role),['user','assistant','user','assistant','user']);
 assert.equal(body.messages[1].content,'첫 답');
 calls=serve({'https://api.openai.com/v1/responses':[200,{output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}]});
 await direct.ask('codex',{key:'k',model:'m'},'이어서',null,two);
 body=JSON.parse(calls[0].options.body);
 assert.deepEqual(body.input.map(x=>[x.role,x.content]).slice(0,2),[['user','첫 질문'],['assistant','첫 답']]);
 // Without earlier turns the request stays as before.
 calls=serve({'https://api.openai.com/v1/responses':[200,{output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}]});
 await direct.ask('codex',{key:'k',model:'m'},'안녕',null);
 assert.equal(JSON.parse(calls[0].options.body).input,JSON.stringify({question:'안녕'}));
});

test('a photo goes with the new question in each AI format',async()=>{
 const image={mime:'image/png',data:'QUJD'};
 let calls=serve({'https://api.anthropic.com/v1/messages':[200,{stop_reason:'end_turn',content:[{type:'text',text:'ok'}]}]});
 await direct.ask('claude',{key:'k',model:'m'},'일정',null,[],image);
 assert.deepEqual(JSON.parse(calls[0].options.body).messages[0].content[0],{type:'image',source:{type:'base64',media_type:'image/png',data:'QUJD'}});
 calls=serve({'https://api.openai.com/v1/responses':[200,{output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}]});
 await direct.ask('codex',{key:'k',model:'m'},'일정',null,[],image);
 assert.deepEqual(JSON.parse(calls[0].options.body).input[0].content[0],{type:'input_image',image_url:'data:image/png;base64,QUJD'});
 calls=serve({'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent':[200,{candidates:[{content:{parts:[{text:'ok'}]}}]}]});
 await direct.ask('antigravity',{key:'k',model:'m'},'일정',null,[],image);
 assert.deepEqual(JSON.parse(calls[0].options.body).contents[0].parts[0],{inlineData:{mimeType:'image/png',data:'QUJD'}});
});
