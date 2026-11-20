/* Ask an AI with the family's own API key, straight from this device.
   The key is kept in this browser only and never sent to the Somhouse server. */
(function (root) {
  'use strict';
  // Keep in sync with SYSTEM in ai.py.
  const SYSTEM = '솜하우스의 가족 도우미로 한국어로 간결하게 답하세요. '
    + '육아 상식, 제품 고르는 기준 같은 일반 질문은 알고 있는 지식으로 답하세요. '
    + '최신 리뷰 순위, 가격, 재고 같은 실시간 정보는 확인할 수 없다고 짧게 밝히고, 알고 있는 범위의 정보와 고르는 기준을 안내하세요. '
    + '가족 기록 질문은 제공된 집계의 날짜, 건수, 수유량만 근거로 삼고 누락된 기록이나 세부 내용을 지어내지 마세요. '
    + '수유량 합계는 ml가 명시된 기록만 포함합니다. 가족 기록 질문에 필요한 집계가 없으면 이를 알리세요. '
    + '기록을 생성하거나 변경했다고 말하지 마세요. 의료 진단이나 처방은 하지 말고 필요하면 소아과 상담을 권하세요.';
  const MAX_ANSWER_LENGTH = 8000, TIMEOUT_MS = 60000;
  const PROVIDERS = {
    codex: {keyName: 'OpenAI API 키', keyPage: 'https://platform.openai.com/api-keys'},
    claude: {keyName: 'Anthropic API 키', keyPage: 'https://console.anthropic.com/settings/keys'},
    antigravity: {keyName: 'Gemini API 키', keyPage: 'https://aistudio.google.com/apikey'},
  };
  const CLAUDE_MODEL = 'claude-opus-5-5';
  // Gemini models with a free tier (Google AI Studio pricing page, checked 2026-11-21), best first.
  // Google's model list does not say which are free, so this is kept by hand. Top 2, middle 2, bottom 1.
  const GEMINI_FREE = [
    ['gemini-3.8-flash', '상위'], ['gemini-4-hydrogen', '상위'],
    ['gemini-3.6-flash', '중위'], ['gemini-3.5-flash-lite', '중위'],
    ['gemini-3.1-flash-lite', '하위'],
  ];
  const GEMINI_TIER = Object.fromEntries(GEMINI_FREE);
  // The free models this key can use; if Google renamed them all, the account's own list.
  function geminiShortlist(list) {
    const free = GEMINI_FREE.map(x => x[0]).filter(id => (list || []).includes(id));
    return free.length ? free : list || [];
  }
  const ANTHROPIC = {'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'};

  function failure(message, status) {const error = Error(message); error.status = status; return error;}
  function version(id) {return (String(id).match(/\d+(?:\.\d+)*/) || ['0'])[0].split('.').map(Number);}
  function newer(a, b) {
    const x = version(a), y = version(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  }

  async function call(url, options) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      const request = {...options, credentials: 'omit', cache: 'no-store', signal: controller.signal};
      response = await (root.fetch ? root.fetch(url, request) : globalThis.fetch(url, request));
    } catch {
      if (controller.signal.aborted) throw failure('AI 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.');
      throw failure('AI 회사에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
    } finally {clearTimeout(timer);}
    let body = {};
    try {body = await response.json();} catch {}
    if (response.ok) return body;
    const detail = String(body?.error?.message || body?.error?.status || body?.error?.type || '').toLowerCase();
    const status = response.status;
    if (status === 401 || detail.includes('api key not valid') || detail.includes('invalid api key') || detail.includes('api_key_invalid'))
      throw failure('API 키가 올바르지 않아요. 키를 확인하고 다시 연결해 주세요.', 401);
    if (detail.includes('credit') || detail.includes('billing') || detail.includes('insufficient_quota') || status === 402)
      throw failure('AI 계정의 크레딧이나 결제 설정을 확인해 주세요.', status);
    if (status === 429 || detail.includes('quota') || detail.includes('resource_exhausted'))
      throw failure('AI 사용 한도에 도달했어요. 잠시 후 다시 시도해 주세요.', 429);
    if (status === 403) throw failure('이 API 키로는 사용할 수 없는 기능이에요. 키 권한을 확인해 주세요.', 403);
    // Before the model check: "The model is overloaded" (503) is a busy server, not a missing model.
    if (status >= 500) throw failure(detail.includes('overloaded') || status === 503 || status === 529
      ? `지금 이 모델에 요청이 몰려 있어요. 잠시 후 다시 시도하거나 다른 모델을 골라 주세요. (오류 ${status})`
      : `AI 회사 서버가 잠시 응답하지 않아요. 잠시 후 다시 시도해 주세요. (오류 ${status})`, status);
    if (status === 404 || detail.includes('model')) throw failure(`고른 모델을 쓸 수 없어요. 다른 모델을 골라 주세요. (오류 ${status})`, status);
    throw failure(`AI 답변을 받지 못했어요. 다시 시도해 주세요. (오류 ${status})`, status);
  }

  // Connecting only lists the models: it checks the key without spending tokens.
  async function models(provider, key) {
    if (provider === 'claude') {
      const body = await call('https://api.anthropic.com/v1/models?limit=1000', {headers: {...ANTHROPIC, 'x-api-key': key}});
      const ids = (body.data || []).map(x => x.id).filter(id => typeof id === 'string' && id.startsWith('claude-'));
      // The current Opus first, then the rest as the account lists them (newest first).
      return [...ids.filter(id => id === CLAUDE_MODEL), ...ids.filter(id => id !== CLAUDE_MODEL)];
    }
    if (provider === 'codex') {
      const body = await call('https://api.openai.com/v1/models', {headers: {Authorization: 'Bearer ' + key}});
      // Text models that answer through the Responses API; skip audio, images, dated snapshots and special-purpose ones.
      return (body.data || []).filter(x => typeof x.id === 'string' && /^(gpt-\d|o\d)/.test(x.id)
        && !/(audio|realtime|transcribe|tts|image|search|codex|cyber|instruct|chat|oss|embedding|moderation|\d{4}-\d{2}-\d{2})/.test(x.id))
        .sort((a, b) => newer(a.id, b.id) || (b.created || 0) - (a.created || 0)).map(x => x.id);
    }
    if (provider === 'antigravity') {
      const body = await call('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {headers: {'x-goog-api-key': key}});
      const list = (body.models || []).filter(x => typeof x.name === 'string' && x.name.startsWith('models/gemini-')
        && (x.supportedGenerationMethods || []).includes('generateContent')
        && !/(image|tts|live|audio|embedding|robotics|computer|exp)/.test(x.name)).map(x => x.name.slice(7));
      // Fast, stable Flash models first; newest version first within each group.
      const rank = id => (id.includes('flash') ? 0 : 2) + (id.includes('preview') ? 1 : 0);
      return geminiShortlist(list.sort((a, b) => rank(a) - rank(b) || newer(a, b)));
    }
    throw failure('지원하지 않는 AI예요.');
  }

  async function connect(provider, key) {
    key = String(key || '').trim();
    if (!/^[\x21-\x7e]{20,300}$/.test(key)) throw failure(`${PROVIDERS[provider]?.keyName || 'API 키'}를 확인해 주세요.`, 400);
    const list = await models(provider, key);
    if (!list.length) throw failure('이 키로 쓸 수 있는 대화 모델을 찾지 못했어요.', 404);
    return {key, model: list[0], models: list.slice(0, 30)};
  }

  function reply(text) {
    const answer = String(text || '').trim();
    if (!answer) throw failure('답변을 확인하지 못했어요. 다시 시도해 주세요.');
    return {answer: answer.slice(0, MAX_ANSWER_LENGTH), truncated: answer.length > MAX_ANSWER_LENGTH};
  }
  const REFUSED = 'AI가 이 질문에는 답하지 않았어요. 질문을 바꿔 다시 시도해 주세요.';

  async function ask(provider, {key, model}, question, records) {
    const context = {question};
    if (records) context.records = records;
    const prompt = JSON.stringify(context);
    if (provider === 'claude') {
      const body = await call('https://api.anthropic.com/v1/messages', {method: 'POST', headers: {
        ...ANTHROPIC, 'x-api-key': key, 'content-type': 'application/json', 'anthropic-beta': 'server-side-fallback-2026-07-01',
      }, body: JSON.stringify({
        model, max_tokens: 16000, system: SYSTEM, output_config: {effort: 'low'}, fallbacks: 'default',
        messages: [{role: 'user', content: prompt}],
      })});
      if (body.stop_reason === 'refusal') throw failure(REFUSED);
      return reply((body.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n'));
    }
    if (provider === 'codex') {
      const body = await call('https://api.openai.com/v1/responses', {method: 'POST', headers: {
        Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
      }, body: JSON.stringify({model, instructions: SYSTEM, input: prompt, store: false})});
      const text = (body.output || []).filter(x => x.type === 'message').flatMap(x => x.content || [])
        .filter(x => x.type === 'output_text').map(x => x.text).join('\n');
      if (!text && (body.output || []).some(x => (x.content || []).some(c => c.type === 'refusal'))) throw failure(REFUSED);
      return reply(text);
    }
    if (provider === 'antigravity') {
      const body = await call(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: {'x-goog-api-key': key, 'Content-Type': 'application/json'},
        body: JSON.stringify({systemInstruction: {parts: [{text: SYSTEM}]}, contents: [{role: 'user', parts: [{text: prompt}]}]}),
      });
      const candidate = (body.candidates || [])[0];
      if (body.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY') throw failure(REFUSED);
      return reply((candidate?.content?.parts || []).map(x => x.text || '').join(''));
    }
    throw failure('지원하지 않는 AI예요.');
  }

  // The same numbers the Mac sends (ai.summarize_records): dates and counts only, never the records themselves.
  const VOLUME = /^([0-9]+(?:\.[0-9]+)?)\s*(?:ml|미리|밀리리터)$/i;
  function addDays(day, count) {const date = new Date(day + 'T12:00:00'); date.setDate(date.getDate() + count); return date.toISOString().slice(0, 10);}
  function summarize(scope, data, today) {
    if (scope === 'shopping') {
      const items = data.shopping || [], completed = items.filter(x => x.done === 'yes').length;
      return {completed, pending: items.length - completed};
    }
    const feeding = scope === 'feeding', items = feeding ? data.records || [] : data.schedule || [];
    const first = feeding ? addDays(today, -6) : today, days = {};
    for (let i = 0; i < 7; i++) days[addDays(first, i)] = feeding ? {count: 0, measured_count: 0, volume_ml: 0} : {count: 0};
    for (const item of items) {
      const day = days[String(item.date || '').slice(0, 10)];
      if (!day || (feeding && item.type !== 'feeding')) continue;
      day.count++;
      const match = feeding && String(item.amount || '').trim().match(VOLUME);
      if (match && Number(match[1]) <= 1000000) {day.measured_count++; day.volume_ml += Number(match[1]);}
    }
    if (feeding) for (const day of Object.values(days)) day.volume_ml = Math.round(day.volume_ml * 100) / 100;
    return days;
  }

  const api = {SYSTEM, PROVIDERS, CLAUDE_MODEL, GEMINI_TIER, geminiShortlist, models, connect, ask, summarize};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SomhouseAI = api;
})(typeof window !== 'undefined' ? window : this);
