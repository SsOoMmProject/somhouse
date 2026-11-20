const {test}=require('node:test');
const assert=require('node:assert/strict');
const {browser,blank}=require('./helpers/browser.cjs');
const providers=(connected,summaries=false)=>[
 {id:'codex',name:'Codex',company:'OpenAI',enabled:connected.includes('codex'),model:null,recordSummaries:summaries},
 {id:'claude',name:'Claude',company:'Anthropic',enabled:connected.includes('claude'),model:'sonnet',recordSummaries:summaries},
 {id:'antigravity',name:'Antigravity',company:'Google',enabled:connected.includes('antigravity'),model:'gemini-3.8-flash-medium',recordSummaries:summaries},
];
const cards=html=>[...html.matchAll(/<details class="ai-provider" data-provider="([a-z]+)"( open)?>/g)].map(m=>[m[1],Boolean(m[2])]);

test('AI form preserves drafts during polling and errors, then displays a plain text answer',async()=>{
 const calls=[];
 let rejectAI=true;
 const b=browser({
  session:{base:'http://127.0.0.1:8787',token:'existing',username:'family1'},
  fetcher:async(url,options)=>{
   calls.push({url,options});
   let result={data:blank()},ok=true;
   if(url.endsWith('/api/ai')){
    if(options.method==='GET')result={enabled:true,providers:providers(['antigravity'],true)};
    else if(rejectAI){result={error:'Gemini failed'};ok=false;}
    else result={answer:'<script>plain text</script>',truncated:false};
   }
   return {ok,status:ok?200:502,json:async()=>result};
  },
 });
 await b.settle();
 b.context.location.hash='#ai';b.events.get('hashchange')();await b.settle();
 assert.equal(b.get('#ai-panel').hidden,false);
 assert.equal(b.get('#ai-fields').disabled,false);
 const form=b.get('#ai-form');
 form.values={question:'수유 요약',scope:'feeding'};
 b.get('#ai-question').value='수유 요약';
 await b.eval('refreshShared(true)');
 assert.equal(b.get('#ai-question').value,'수유 요약');
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(b.get('#ai-question').value,'수유 요약');
 assert.equal(b.get('#ai-status').textContent,'Gemini failed');
 rejectAI=false;
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(b.get('#ai-answer').textContent,'<script>plain text</script>');
 assert.equal(b.get('#ai-answer').innerHTML,'');
 assert.equal(b.get('#ai-result').hidden,false);
 assert.equal(b.get('#ai-question').value,'');
 const request=calls.filter(x=>x.url.endsWith('/api/ai')&&x.options.method==='POST').at(-1);
 assert.deepEqual(JSON.parse(request.options.body),{question:'수유 요약',scope:'feeding',provider:'antigravity'});
 assert.equal(b.get('#ai-result-title').textContent,'Antigravity 답변');
 await b.get('#logout').onclick();
 assert.equal(b.get('#ai-panel').hidden,true);
 assert.equal(b.get('#ai-answer').textContent,'');
});

test('an AI response arriving after logout cannot reappear in the next login',async()=>{
 let finishAI;
 const b=browser({
  session:{base:'http://127.0.0.1:8787',token:'existing',username:'family1'},
  fetcher:async(url,options)=>{
   let result={data:blank()};
   if(url.endsWith('/api/ai')){
    if(options.method==='GET')result={enabled:true,providers:providers(['claude'])};
    else result=await new Promise(resolve=>{finishAI=()=>resolve({answer:'old answer'});});
   }
   return {ok:true,json:async()=>result};
  },
 });
 await b.settle();
 b.context.location.hash='#ai';b.events.get('hashchange')();await b.settle();
 const form=b.get('#ai-form');
 form.values={question:'안녕',scope:'feeding'};
 const pending=form.onsubmit({preventDefault(){},target:form});
 await b.settle();
 assert.equal(b.get('#ai-fields').disabled,true);
 await b.get('#logout').onclick();
 finishAI();await pending;
 assert.equal(b.get('#ai-answer').textContent,'');
 assert.equal(b.eval('mode'),'login');
});

test('AI cards stay folded unless connected, and the picked AI answers the question',async()=>{
 const calls=[];
 const b=browser({
  session:{base:'http://127.0.0.1:8787',token:'existing',username:'family1'},
  fetcher:async(url,options)=>{
   calls.push({url,options});
   let result={data:blank()};
   if(url.endsWith('/api/ai'))result=options.method==='GET'?{enabled:true,providers:providers(['codex','claude'])}:{answer:'답',truncated:false};
   return {ok:true,json:async()=>result};
  },
 });
 await b.settle();
 b.context.location.hash='#ai';b.events.get('hashchange')();await b.settle();
 const html=b.get('#ai-providers').innerHTML;
 // Gemini is always first and open; connected ones follow, open.
 assert.deepEqual(cards(html),[['antigravity',true],['codex',true],['claude',true]]);
 assert.doesNotMatch(html,/앱에서 질문하기/);
 assert.match(html,/python3 server\.py ai-config --provider antigravity/);
 assert.match(html,/id="ai-key-antigravity"/);
 assert.doesNotMatch(html,/value="mac:antigravity"/);
 assert.match(html,/value="mac:codex" checked/);
 assert.equal(b.get('#ai-scope-field').hidden,true);
 assert.equal(b.get('#ai-status').textContent,'맥미니 Codex에게 질문해요. 질문마다 새로 답해요.');
 b.get('#ai-providers').onchange({target:{name:'provider',value:'mac:claude'}});
 assert.equal(b.get('#ai-status').textContent,'맥미니 Claude에게 질문해요. 질문마다 새로 답해요.');
 // Picking an AI that is not connected is ignored.
 b.get('#ai-providers').onchange({target:{name:'provider',value:'mac:antigravity'}});
 assert.equal(b.get('#ai-fields').disabled,true);
 b.get('#ai-providers').onchange({target:{name:'provider',value:'mac:claude'}});
 assert.equal(b.get('#ai-fields').disabled,false);
 const form=b.get('#ai-form');
 form.values={question:'안녕',scope:'feeding'};
 await form.onsubmit({preventDefault(){},target:form});
 const request=calls.filter(x=>x.url.endsWith('/api/ai')&&x.options.method==='POST').at(-1);
 assert.deepEqual(JSON.parse(request.options.body),{question:'안녕',scope:'none',provider:'claude'});
 assert.equal(b.get('#ai-result-title').textContent,'Claude 답변');
 // The choice is remembered for the next visit.
 assert.equal(b.context.localStorage.getItem('somhouse-ai-provider'),'mac:claude');
});

test('another family connects its own Claude key on this device and asks without the Mac',async()=>{
 const calls=[],key='sk-ant-api03-'+'x'.repeat(40);
 const records=[{id:'f1',type:'feeding',date:'',category:'분유',amount:'90ml',memo:'PRIVATE-MEMO'}];
 const b=browser({
  session:{base:'http://127.0.0.1:8787',token:'existing',username:'mom@example.com'},
  fetcher:async(url,options)=>{
   calls.push({url,options});
   if(url==='https://api.anthropic.com/v1/models?limit=1000')return {ok:true,status:200,json:async()=>({data:[{id:'claude-sonnet-5-5'},{id:'claude-opus-5-5'},{id:'claude-haiku-5-5'}]})};
   if(url==='https://api.anthropic.com/v1/messages')return {ok:true,status:200,json:async()=>({stop_reason:'end_turn',content:[{type:'thinking',thinking:''},{type:'text',text:'내 키 답변'}]})};
   if(url.endsWith('/api/ai'))return {ok:true,json:async()=>({enabled:false,homeOnly:true,providers:providers([])})};
   return {ok:true,json:async()=>({data:{...blank(),records}})};
  },
 });
 records[0].date=b.eval('Somhouse.localDateTime()');
 await b.settle();
 b.context.location.hash='#ai';b.events.get('hashchange')();await b.settle();
 assert.deepEqual(cards(b.get('#ai-providers').innerHTML),[['antigravity',true],['codex',false],['claude',false]]);
 // Other families are never told to set up the Mac.
 assert.doesNotMatch(b.get('#ai-providers').innerHTML,/server\.py/);
 assert.equal(b.get('#ai-fields').disabled,true);
 b.get('#ai-key-claude').value='  '+key+'  ';
 await b.get('#ai-providers').onclick({target:{closest:()=>({dataset:{aiConnect:'claude'}})}});
 await b.settle();
 assert.match(b.get('#ai-status').textContent,/연결했어요. 모델: claude-opus-5-5/);
 const html=b.get('#ai-providers').innerHTML;
 assert.deepEqual(cards(html),[['antigravity',true],['claude',true],['codex',false]]);
 assert.doesNotMatch(html,/Claude 앱에서 질문하기/);
 assert.match(html,/value="key:claude" checked/);
 assert.match(html,/<option value="claude-opus-5-5" selected>/);
 // The key is kept per account in this browser.
 const stored=JSON.parse(b.context.localStorage.getItem('somhouse-ai-keys-v1'));
 assert.equal(stored['http://127.0.0.1:8787|mom@example.com'].claude.key,key);
 assert.equal(b.get('#ai-fields').disabled,false);
 assert.equal(b.get('#ai-scope-field').hidden,false);
 const form=b.get('#ai-form');
 form.values={question:'수유 요약',scope:'feeding'};
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(b.get('#ai-answer').textContent,'내 키 답변');
 const sent=calls.find(x=>x.url==='https://api.anthropic.com/v1/messages');
 assert.equal(sent.options.headers['x-api-key'],key);
 assert.equal(sent.options.headers['anthropic-dangerous-direct-browser-access'],'true');
 const body=JSON.parse(sent.options.body);
 assert.equal(body.model,'claude-opus-5-5');
 assert.equal(body.fallbacks,'default');
 const context=JSON.parse(body.messages[0].content);
 assert.equal(context.question,'수유 요약');
 assert.deepEqual(context.records.summary[records[0].date.slice(0,10)],{count:1,measured_count:1,volume_ml:90});
 assert.doesNotMatch(sent.options.body,/PRIVATE-MEMO/);
 // Nothing about the key or the question went to the Mac.
 for(const call of calls.filter(x=>x.url.startsWith('http://127.0.0.1')))assert.doesNotMatch(JSON.stringify(call.options),/sk-ant|수유 요약/);
 // Another account on the same device does not see this key.
 b.eval("shared.username='dad@example.com'");
 assert.equal(b.eval("aiOptions().length"),0);
 b.eval("shared.username='mom@example.com'");
 b.get('#ai-providers').onclick({target:{closest:()=>({dataset:{aiDisconnect:'claude'}})}});
 assert.equal(b.context.localStorage.getItem('somhouse-ai-keys-v1'),'{}');
 assert.equal(b.get('#ai-fields').disabled,true);
});

test('a wrong key is reported and not saved',async()=>{
 const b=browser({
  session:{base:'http://127.0.0.1:8787',token:'existing',username:'family1'},
  fetcher:async(url,options)=>{
   if(url.startsWith('https://api.openai.com/'))return {ok:false,status:401,json:async()=>({error:{message:'Incorrect API key provided'}})};
   if(url.endsWith('/api/ai'))return {ok:true,json:async()=>({enabled:false,providers:providers([])})};
   return {ok:true,json:async()=>({data:blank()})};
  },
 });
 await b.settle();
 b.context.location.hash='#ai';b.events.get('hashchange')();await b.settle();
 b.get('#ai-key-codex').value='short';
 await b.get('#ai-providers').onclick({target:{closest:()=>({dataset:{aiConnect:'codex'}})}});
 await b.settle();
 assert.equal(b.get('#ai-status').textContent,'OpenAI API 키를 확인해 주세요.');
 b.get('#ai-key-codex').value='sk-proj-'+'y'.repeat(40);
 await b.get('#ai-providers').onclick({target:{closest:()=>({dataset:{aiConnect:'codex'}})}});
 await b.settle();
 assert.match(b.get('#ai-status').textContent,/API 키가 올바르지 않아요/);
 assert.equal(b.context.localStorage.getItem('somhouse-ai-keys-v1'),null);
});

test('without ChatGPT sign-in on the server, Gemini comes first and the others link to their apps',async()=>{
 const b=browser({
  session:{base:'http://127.0.0.1:8787',token:'existing',username:'family1'},
  fetcher:async(url,options)=>({ok:true,json:async()=>url.endsWith('/api/ai')?{enabled:false,providers:providers([])}:{data:blank()}}),
 });
 await b.settle();
 b.context.location.hash='#ai';b.events.get('hashchange')();await b.settle();
 assert.deepEqual(cards(b.get('#ai-providers').innerHTML),[['antigravity',true],['codex',false],['claude',false]]);
 assert.equal(b.get('#ai-fields').disabled,true);
 const html=b.get('#ai-providers').innerHTML;
 assert.match(html,/<strong>Gemini<\/strong><span class="caption">Google<\/span><span class="badge off">무료로 시작/);
 assert.match(html,/무료로 키를 받아 시작할 수 있어요/);
 // Gemini's key form is open; paid keys stay folded behind each app's link.
 const gemini=html.match(/data-provider="antigravity"[\s\S]*?<\/details>/)[0];
 assert.match(gemini,/id="ai-key-antigravity"/);
 assert.match(gemini,/<div class="body"><label class="field">Gemini API 키로 연결/);
 assert.match(html,/href="https:\/\/chatgpt\.com\/"[^>]*>ChatGPT 앱에서 질문하기/);
 assert.match(html,/OpenAI 승인 후 열려요/);
 assert.match(html,/href="https:\/\/claude\.ai\/"[^>]*>Claude 앱에서 질문하기/);
 assert.match(html,/<summary>OpenAI API 키로 연결하기 \(유료\)<\/summary><label class="field">OpenAI API 키로 연결<input type="password" id="ai-key-codex"/);
 assert.match(html,/<summary>Anthropic API 키로 연결하기 \(유료\)<\/summary>/);
 assert.doesNotMatch(html,/서버 설정 필요|data-plan="start"|value="plan:chatgpt"|data-provider="chatgpt"/);
 assert.match(b.get('#ai-status').textContent,/Gemini API 키를 연결하면/);
 assert.equal(b.eval("aiName({mode:'key',p:{id:'antigravity',name:'Antigravity'}})"),'Gemini');
 assert.equal(b.eval("aiName({mode:'mac',p:{id:'antigravity',name:'Antigravity'}})"),'Antigravity');
});

test('personal plan stays inside the app and never falls back to another billing path',async()=>{
 const calls=[];
 let limited=true;
 const b=browser({hash:'#chatgpt=once',session:{base:'http://127.0.0.1:8787',token:'member',username:'family'},fetcher:async(url,options)=>{
  calls.push({url,options});
  let result={data:blank()};
  if(url.endsWith('/api/chatgpt/finish'))result={connected:true};
  if(url.endsWith('/api/ai'))result={providers:providers(['codex']),enabled:true,chatgptPlan:{connected:true,model:'personal-model',email:'a@example.test'}};
  if(url.endsWith('/api/chatgpt/models'))result={connected:true,model:'personal-model',models:[{slug:'personal-model',name:'First'},{slug:'second',name:'Second & Plus'}]};
  if(url.endsWith('/api/chatgpt/ask')){
   if(limited)return {ok:false,status:429,json:async()=>({error:'ChatGPT 사용 한도'})};
   result={answer:'구독으로 답했어요.'};
  }
  return {ok:true,json:async()=>result};
 }});
 await b.settle();await b.settle();
 assert.equal(b.eval('ai.selected'),'plan:chatgpt');
 assert.match(b.get('#ai-providers').innerHTML,/사용량 관리/);
 assert.match(b.get('#ai-providers').innerHTML,/<option value="personal-model" selected>First/);
 b.get('#ai-providers').onchange({target:{dataset:{aiModel:'chatgpt'},value:'second'}});
 assert.match(b.get('#ai-providers').innerHTML,/<option value="second" selected>Second &amp; Plus/);
 assert.equal(b.get('#ai-scope-field').hidden,true);
 const form=b.get('#ai-form');form.values={question:'Hello',scope:'feeding'};
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(b.get('#ai-status').textContent,'ChatGPT 사용 한도');
 limited=false;
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(b.get('#ai-answer').textContent,'구독으로 답했어요.');
 const asks=calls.filter(x=>x.url.endsWith('/api/chatgpt/ask'));
 assert.equal(asks.length,2);
 assert.deepEqual(JSON.parse(asks[0].options.body),{question:'Hello',scope:'none',model:'second'});
 assert.ok(!calls.some(x=>x.url.endsWith('/api/ai')&&x.options.method==='POST'));
});
