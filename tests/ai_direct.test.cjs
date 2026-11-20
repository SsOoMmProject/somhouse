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
   {name:'models/gemini-3.7-pro',supportedGenerationMethods:['generateContent']},
   {name:'models/gemini-3.8-flash-preview',supportedGenerationMethods:['generateContent']},
   {name:'models/gemini-3.7-flash',supportedGenerationMethods:['generateContent']},
   {name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']},
   {name:'models/gemini-3.8-flash-image',supportedGenerationMethods:['generateContent']},
   {name:'models/gemini-embedding-2',supportedGenerationMethods:['embedContent']},
  ]}],
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent':[200,{candidates:[{content:{parts:[{text:'답'},{text:'변'}]}}]}],
 });
 const saved=await direct.connect('antigravity','AIza'+'b'.repeat(35));
 assert.deepEqual(saved.models,['gemini-3.8-flash','gemini-3.7-flash','gemini-3.8-flash-preview','gemini-3.7-pro']);
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
  [400,{error:{message:'Your credit balance is too low'}},/크레딧/],[529,{error:{type:'overloaded_error'}},/잠시 후/],[404,{error:{message:'model: x'}},/다른 모델/]];
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
  ],
  schedule:[{date:'2026-11-20'},{date:'2026-11-26T09:00'},{date:'2026-11-27'},{date:'2026-11-19'}],
  shopping:[{done:'yes'},{done:'no'},{}],
 };
 const script='import json,sys\nfrom datetime import date\nfrom ai import summarize_records\nd=json.load(sys.stdin)\n'
  +'print(json.dumps({s:summarize_records(s,d[{"feeding":"records"}.get(s,s)],date(2026,11,20)) for s in ("feeding","schedule","shopping")}))';
 const python=JSON.parse(execFileSync('python3',['-c',script],{cwd:path.resolve(__dirname,'..'),input:JSON.stringify(data)}));
 for(const scope of ['feeding','schedule','shopping'])assert.deepEqual(direct.summarize(scope,data,today),python[scope],scope);
});
