const fs=require('node:fs');
const vm=require('node:vm');
const blank=()=>({records:[],schedule:[],shopping:[]});
const clone=value=>JSON.parse(JSON.stringify(value));
function family(){return {data:blank(),imported:new Set(),failure:null,readGate:null};}
function browser({hash='',raw=JSON.stringify(blank()),session=null,local=new Map([['somhouse-v1',raw]]),server=family(),fetcher=null}={}){
 const sessionData=new Map(session?[['somhouse-session-v1',JSON.stringify(session)]]:[]);
 const elements=new Map(),events=new Map(),calls=[],alerts=[],timers=[];
 let blockRead=false,blockWrite=false;
 const element=()=>({classList:{add(){},toggle(){}},setAttribute(){},removeAttribute(){},prepend(){},addEventListener(){},querySelector(){return element();},values:{},reset(){this.values={};},innerHTML:'',textContent:'',value:'',hidden:false,open:false,close(){this.open=false;},showModal(){this.open=true;}});
 const get=sel=>{if(!elements.has(sel))elements.set(sel,element());return elements.get(sel);};
 const context={console,URL,AbortController,FormData:class extends Map{constructor(form){super(Object.entries(form.values));}},setTimeout,clearTimeout,setInterval:(callback,delay)=>timers.push({callback,delay}),Date,URLSearchParams,history:{replaceState(_s,_t,url){context.location.hash='';}},location:{hash,hostname:'localhost',origin:'http://localhost:8765',pathname:'/',search:''},
 localStorage:{getItem:k=>{if(blockRead&&k==='somhouse-v1')throw Error('blocked');return local.get(k)??null;},setItem:(k,v)=>{if(blockWrite)throw Error('full');local.set(k,v);},removeItem:k=>local.delete(k)},
 sessionStorage:{getItem:k=>sessionData.get(k)??null,setItem:(k,v)=>sessionData.set(k,v),removeItem:k=>sessionData.delete(k)},alert:s=>alerts.push(s),confirm:()=>true,
 document:{hidden:false,activeElement:null,querySelector:get,querySelectorAll:()=>[],addEventListener:(name,fn)=>events.set(name,fn),createElement:element},
 fetch:async(url,options)=>{
  calls.push({url,options});if(server.failure)throw server.failure;
  let result;
  if(url.endsWith('/api/login/google'))result={token:'google-token',username:'family',read_only:false};
  else if(url.endsWith('/api/google/start'))result={url:'https://accounts.google.com/o/oauth2/v2/auth?state=x'};
  else if(url.endsWith('/api/login')){const username=JSON.parse(options.body).username;result={token:'test-token',username,read_only:username==='guest'};}
  else if(url.endsWith('/api/merge')){
   const original=JSON.parse(options.body);
   for(const k of Object.keys(original))for(const item of original[k]){const key=k+':'+item.id;if(!server.imported.has(key)&&!server.data[k].some(x=>x.id===item.id))server.data[k].push(clone(item));server.imported.add(key);}
   result={data:clone(server.data)};
  }else if(url.endsWith('/api/confirm')){
   const request=JSON.parse(options.body);(server.confirms||=[]).push(request);server.aliases||={};
   if(request.forget)delete server.aliases[request.forget];
   else{
    const item=server.data.records.find(x=>x.id===request.id);
    if(item.heard&&request.category!=='기타')server.aliases[item.heard]=request.category;
    item.category=request.category;delete item.confirm;
   }
   result={data:clone(server.data),aliases:clone(server.aliases)};
  }else if(url.endsWith('/api/review')){
   const request=JSON.parse(options.body);(server.reviews||=[]).push(request);
   if(request.action==='save')server.data[request.kind].push(clone({...request.item,id:'review-'+request.key}));
   const items=(server.googleStatus?.review_items||[]).filter(x=>x.key!==request.key);
   server.googleStatus={...server.googleStatus,review:items.length,review_items:items};
   result={data:clone(server.data),sources:server.sources,google_status:server.googleStatus};
  }else if(url.endsWith('/api/settings')){
   const request=JSON.parse(options.body);(server.settingsCalls||=[]).push(request);server.settings={children:request.children};
   for(const x of server.data.schedule)if(request.rename&&request.rename[x.who])x.who=request.rename[x.who];
   result={data:clone(server.data),settings:clone(server.settings),moved:0};
  }else if(options.method==='PUT'){
   const item=JSON.parse(options.body),kind=url.split('/').at(-2);
   server.data[kind]=server.data[kind].filter(x=>x.id!==item.id);server.data[kind].push(clone(item));if(item.type==='feeding'){const open=server.data.records.filter(x=>x.type==='sleep'&&!x.end&&x.date<item.date).sort((a,b)=>b.date.localeCompare(a.date))[0];if(open)open.end=item.date;}if(item.heard&&['분유','모유','혼합'].includes(item.category))(server.aliases||={})[item.heard]=item.category;result={data:clone(server.data),aliases:clone(server.aliases||{})};
  }else if(options.method==='DELETE'){
   const parts=url.split('/'),kind=parts.at(-2),id=decodeURIComponent(parts.at(-1));server.data[kind]=server.data[kind].filter(x=>x.id!==id);result={data:clone(server.data)};
  }else result={data:clone(server.data),sources:server.sources,google_status:server.googleStatus,aliases:server.aliases,calendar_events:server.calendarEvents,holidays:server.holidays,read_only:server.readOnly,settings:server.settings};
  if(url.endsWith('/api/data')&&server.readGate){const gate=server.readGate;server.readGate=null;await gate;}
  return {ok:true,json:async()=>result};
 }};
 if(fetcher)context.fetch=fetcher;
 context.window=context;context.addEventListener=(name,fn)=>events.set(name,fn);
 vm.createContext(context);
 for(const path of ['service.js','shared.js','app.js'])vm.runInContext(fs.readFileSync(require.resolve('../../'+path),'utf8'),context);
 return {eval:code=>vm.runInContext(code,context),local,sessionData,calls,alerts,get,server,events,timers,context,
  fail:error=>server.failure=error,blockRead:()=>blockRead=true,blockWrite:()=>blockWrite=true,settle:()=>new Promise(resolve=>setImmediate(resolve)),
  login:async(name='family1',password='password',base='http://127.0.0.1:8787')=>{await vm.runInContext(`shared.login(${JSON.stringify(base)},${JSON.stringify(name)},${JSON.stringify(password)})`,context);vm.runInContext("mode='shared'",context);await vm.runInContext('refreshShared(true)',context);}};
}
module.exports={browser,family,blank};
