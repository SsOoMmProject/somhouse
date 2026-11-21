'use strict';
/* Ask about the family's records in plain words. The answer is counted on this device, so its numbers cannot be made up
   and no record leaves the phone. Common questions are understood by rules alone. Only when those fail, and only if the
   family connected an AI, the question's words go to that AI to be turned into a small query; records are never sent. */
(function (root) {
  const METRICS = {
    feeding_count: '수유 횟수', feeding_ml: '수유량(ml)', breast_minutes: '직수 시간', feed_gap: '평균 수유 간격', last_feeding: '마지막 수유',
    sleep_total: '총 수면 시간', nap_count: '낮잠 횟수', longest_sleep: '가장 긴 잠', last_sleep: '마지막 수면',
    diaper_count: '기저귀 횟수', poo_count: '대변 횟수', pee_count: '소변 횟수', last_poo: '마지막 대변',
  };
  const PARTS = {dawn: ['새벽', 0, 6], night: ['밤중', 22, 6], morning: ['오전', 6, 12], afternoon: ['오후', 12, 18], evening: ['저녁', 18, 22]};
  const MAX_DAYS = 400, QUESTION_MAX = 200;
  const pad = n => String(n).padStart(2, '0');
  const dayOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const shift = (day, n) => { const [y, m, d] = day.split('-').map(Number); return dayOf(new Date(y, m - 1, d + n)); };
  const realDay = v => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false; const [y, m, d] = v.split('-').map(Number), t = new Date(y, m - 1, d); return t.getMonth() === m - 1 && t.getDate() === d; };
  const weekFirst = day => { const [y, m, d] = day.split('-').map(Number); return shift(day, -new Date(y, m - 1, d).getDay()); };
  const daysBetween = (a, b) => { const [x, y] = [a, b].map(v => { const [yy, m, d] = v.split('-').map(Number); return Date.UTC(yy, m - 1, d); }); return Math.round((y - x) / 86400000); };

  function period(text, today) {
    const recent = text.match(/(?:최근|지난)\s*(\d{1,3})\s*일/);
    if (recent) { const n = Math.min(Math.max(Number(recent[1]), 1), MAX_DAYS); return {from: shift(today, 1 - n), to: today, label: `최근 ${n}일`}; }
    const date = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (date) {
      let year = Number(today.slice(0, 4)), day = `${year}-${pad(Number(date[1]))}-${pad(Number(date[2]))}`;
      if (realDay(day) && day > today) { year--; day = `${year}-${pad(Number(date[1]))}-${pad(Number(date[2]))}`; }
      if (realDay(day)) return {from: day, to: day, label: `${Number(date[1])}월 ${Number(date[2])}일`};
    }
    if (/그저께|그제/.test(text)) { const d = shift(today, -2); return {from: d, to: d, label: '그저께'}; }
    if (/어제|어젯/.test(text)) { const d = shift(today, -1); return {from: d, to: d, label: '어제'}; }
    if (/지난\s*주|저번\s*주/.test(text)) { const first = shift(weekFirst(today), -7); return {from: first, to: shift(first, 6), label: '지난주'}; }
    if (/이번\s*주|금주/.test(text)) return {from: weekFirst(today), to: today, label: '이번 주'};
    if (/지난\s*달|저번\s*달/.test(text)) {
      const [y, m] = today.split('-').map(Number), first = dayOf(new Date(y, m - 2, 1));
      return {from: first, to: dayOf(new Date(y, m - 1, 0)), label: '지난달'};
    }
    if (/이번\s*달/.test(text)) return {from: today.slice(0, 8) + '01', to: today, label: '이번 달'};
    return {from: today, to: today, label: '오늘'};
  }
  function dayPart(text) {
    const words = text.replace(/밤잠/g, '');
    if (/밤중|한밤/.test(words)) return 'night';
    if (/새벽/.test(words)) return 'dawn';
    if (/오전|아침/.test(words)) return 'morning';
    if (/오후|낮(?!잠)/.test(words)) return 'afternoon';
    if (/저녁/.test(words)) return 'evening';
    return '';
  }
  function metric(text) {
    const when = /언제|마지막|몇\s*시에/.test(text);
    if (/대변|응가|똥/.test(text)) return when ? 'last_poo' : 'poo_count';
    if (/소변|오줌|(?:^|\s)쉬/.test(text)) return 'pee_count';
    if (/기저귀/.test(text)) return 'diaper_count';
    if (/낮잠/.test(text) && /몇\s*(번|회)|횟수/.test(text)) return 'nap_count';
    if (/잠|수면|잤|깼/.test(text)) {
      if (when) return 'last_sleep';
      if (/가장\s*길|제일\s*길|최장|오래/.test(text)) return 'longest_sleep';
      return 'sleep_total';
    }
    if (/수유|먹|맘마|분유|모유|직수/.test(text)) {
      if (when) return 'last_feeding';
      if (/간격/.test(text)) return 'feed_gap';
      if (/직수/.test(text) && /분|시간|얼마/.test(text)) return 'breast_minutes';
      if (/ml|미리|밀리|얼마나|양|량|총/i.test(text) && !/몇\s*(번|회)|횟수/.test(text)) return 'feeding_ml';
      return 'feeding_count';
    }
    return '';
  }
  function understand(question, today) {
    const text = String(question || '').slice(0, QUESTION_MAX), id = metric(text);
    if (!id) return null;
    return {metric: id, ...period(text, today), part: dayPart(text), average: /평균/.test(text)};
  }
  // Only the shape below is accepted from an AI; anything else is treated as not understood.
  function fromAI(json, today) {
    if (!json || typeof json !== 'object' || !Object.hasOwn(METRICS, json.metric)) return null;
    const from = json.from, to = json.to;
    if (!realDay(from) || !realDay(to) || from > to || to > today || daysBetween(from, to) >= MAX_DAYS) return null;
    if (json.part && !Object.hasOwn(PARTS, json.part)) return null;
    return {metric: json.metric, from, to, label: from === to ? `${Number(from.slice(5, 7))}월 ${Number(from.slice(8))}일` : `${from} ~ ${to}`,
            part: json.part || '', average: json.average === true};
  }
  const hourIn = (stamp, part) => {
    if (!part) return true;
    const hour = Number(stamp.slice(11, 13)), [, a, b] = PARTS[part];
    return a < b ? hour >= a && hour < b : hour >= a || hour < b;
  };
  // Records of that period and time of day, up to now. "밤중" of a day runs into the next morning.
  function within(records, type, q, now) {
    const last = q.part === 'night' ? shift(q.to, 1) : q.to;
    return records.filter(x => x.type === type && x.date && x.date <= now && hourIn(x.date, q.part)).filter(x => {
      const day = x.date.slice(0, 10);
      if (q.part !== 'night') return day >= q.from && day <= q.to;
      const owner = Number(x.date.slice(11, 13)) < 6 ? shift(day, -1) : day;
      return owner >= q.from && owner <= q.to && day <= last;
    }).sort((a, b) => a.date.localeCompare(b.date));
  }
  const nightDay = x => (Number(x.date.slice(11, 13)) < 6 ? shift(x.date.slice(0, 10), -1) : x.date.slice(0, 10));
  const daysOf = (list, part) => new Set(list.map(x => (part === 'night' ? nightDay(x) : x.date.slice(0, 10)))).size;
  const when = v => `${Number(v.slice(5, 7))}월 ${Number(v.slice(8, 10))}일 ${v.slice(11, 16)}`;
  const one = v => (Math.round(v * 10) / 10).toLocaleString('ko-KR');
  function dayList(q) { const out = []; for (let d = q.from; d <= q.to; d = shift(d, 1)) out.push(d); return out; }

  function compute(q, records, now, S) {
    const scope = `${q.label}${q.part ? ` ${PARTS[q.part][0]}` : ''}`;
    const counted = (type, keep, unit, name) => {
      const list = within(records, type, q, now).filter(keep), days = daysOf(list, q.part);
      if (q.average && list.length) return {text: `${scope} ${name} 기록이 있는 ${days}일 동안 하루 평균 ${one(list.length / days)}${unit}이에요.`, count: list.length};
      return {text: `${scope} ${name} ${list.length}${unit}이에요.`, count: list.length};
    };
    const none = name => ({text: `${scope}에는 ${name} 기록이 없어요.`, count: 0});
    switch (q.metric) {
      case 'feeding_count': return counted('feeding', () => true, '번', '수유는');
      case 'diaper_count': return counted('diaper', () => true, '번', '기저귀는');
      case 'poo_count': return counted('diaper', x => x.category !== '소변', '번', '대변은');
      case 'pee_count': return counted('diaper', x => x.category !== '대변', '번', '소변은');
      case 'feeding_ml': {
        const list = within(records, 'feeding', q, now), ml = list.map(x => S.feedingVolume(x.amount)).filter(v => v !== null);
        if (!ml.length) return none('ml로 적은 수유');
        const total = ml.reduce((a, b) => a + b, 0), skipped = list.length - ml.length, note = skipped ? ` (ml가 없는 ${skipped}건은 빠졌어요)` : '';
        if (q.average) { const days = daysOf(list.filter(x => S.feedingVolume(x.amount) !== null), q.part); return {text: `${scope} 수유량은 기록이 있는 ${days}일 동안 하루 평균 ${one(total / days)}ml이에요.${note}`, count: ml.length}; }
        return {text: `${scope} 수유량은 모두 ${one(total)}ml이에요.${note}`, count: ml.length};
      }
      case 'breast_minutes': {
        const list = within(records, 'feeding', q, now), mins = list.map(x => S.feedingMinutes(x.amount)).filter(v => v !== null);
        return mins.length ? {text: `${scope} 직수는 ${mins.length}번, 모두 ${S.duration(Math.round(mins.reduce((a, b) => a + b, 0)))}이에요.`, count: mins.length} : none('분으로 적은 직수');
      }
      case 'feed_gap': {
        const list = within(records, 'feeding', q, now), gaps = list.slice(1).map((x, i) => S.sleepMinutes({date: list[i].date, end: x.date})).filter(m => m !== null && m <= 8 * 60);
        return gaps.length ? {text: `${scope} 평균 수유 간격은 ${S.duration(Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length))}이에요.`, count: gaps.length + 1} : none('간격을 잴 수 있는 수유');
      }
      case 'last_feeding': {
        const x = records.filter(r => r.type === 'feeding' && r.date && r.date <= now).sort((a, b) => b.date.localeCompare(a.date))[0];
        return x ? {text: `마지막 수유는 ${when(x.date)}, ${x.category} ${x.amount}이에요.`, count: 1} : {text: '수유 기록이 없어요.', count: 0};
      }
      case 'last_poo': {
        const x = S.lastPoo(records, new Date(now + ':00'));
        return x ? {text: `마지막 대변은 ${when(x.date)}이에요.`, count: 1} : {text: '대변 기록이 없어요.', count: 0};
      }
      case 'last_sleep': {
        const x = records.filter(r => r.type === 'sleep' && r.date && r.date <= now).sort((a, b) => b.date.localeCompare(a.date))[0];
        if (!x) return {text: '수면 기록이 없어요.', count: 0};
        return {text: x.end ? `마지막 잠은 ${when(x.date)}부터 ${when(x.end)}까지예요.` : `${when(x.date)}부터 자고 있어요 (깬 시각 없음).`, count: 1};
      }
      case 'sleep_total': case 'nap_count': case 'longest_sleep': {
        const at = new Date(now + ':00'), days = dayList(q).map(d => S.sleepDay(records, d, at)), seen = days.filter(x => x.recorded), name = q.part ? ` (잠은 시간대를 나누지 않고 ${q.label} 전체로 셌어요)` : '';
        if (!seen.length) return none('수면');
        if (q.metric === 'nap_count') { const naps = seen.reduce((s, x) => s + x.naps, 0); return {text: `${q.label} 낮잠은 ${q.average ? `기록이 있는 ${seen.length}일 동안 하루 평균 ${one(naps / seen.length)}번` : `${naps}번`}이에요.${name}`, count: naps}; }
        if (q.metric === 'longest_sleep') { const longest = Math.max(...seen.map(x => x.longest)); return longest ? {text: `${q.label} 가장 긴 잠은 ${S.duration(longest)}이에요.${name}`, count: 1} : none('깬 시각까지 적은 수면'); }
        const total = seen.reduce((s, x) => s + x.total, 0);
        return {text: q.average || seen.length > 1 ? `${q.label} 수면은 기록이 있는 ${seen.length}일 동안 하루 평균 ${S.duration(Math.round(total / seen.length))}이에요.${name}` : `${q.label} 수면은 ${S.duration(total)}이에요.${name}`, count: seen.length};
      }
      default: return {text: '답을 계산하지 못했어요.', count: 0};
    }
  }
  const aiPrompt = (question, today) => `아래 질문을 육아 기록 조회 조건으로 바꿔 JSON 하나만 답하세요. 설명과 코드 블록 없이 {"metric":"","from":"YYYY-MM-DD","to":"YYYY-MM-DD","part":"","average":false} 형식입니다.
오늘은 ${today}입니다. from과 to는 오늘 이전이어야 합니다.
metric은 다음 중 하나: ${Object.entries(METRICS).map(([k, v]) => `${k}(${v})`).join(', ')}
part는 ${Object.entries(PARTS).map(([k, v]) => `${k}(${v[0]})`).join(', ')} 또는 빈 문자열입니다. average는 하루 평균을 물을 때만 true입니다.
육아 기록 조회가 아니면 {"metric":""}로 답하세요.
질문: ${String(question).slice(0, QUESTION_MAX)}`;
  const api = {METRICS, understand, fromAI, compute, aiPrompt};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.SomhouseAsk = api;

  const H = SomhouseFeatures, ui = {text: '', answer: '', note: '', working: false};
  async function ask() {
    const question = ui.text.trim(), now = Somhouse.localDateTime(), today = now.slice(0, 10);
    if (!question) { ui.answer = ''; ui.note = '궁금한 것을 적어 주세요.'; render(); return; }
    let q = understand(question, today), note = '기록을 이 기기에서 직접 세었어요. 아무 데도 보내지 않았어요.';
    if (!q) {
      const picked = typeof aiHelpOption === 'function' ? aiHelpOption() : null;
      if (!picked) { ui.answer = ''; ui.note = '이해하지 못했어요. 예처럼 ‘어제 수유 몇 번’, ‘지난주 평균 수면’처럼 물어봐 주세요.'; render(); return; }
      const state = ai;
      ui.working = true; ui.answer = ''; ui.note = `${aiName(picked)}에게 질문 문장만 보내 해석하고 있어요…`; render();
      try {
        const answer = await aiHelpAsk(picked, aiPrompt(question, today));
        if (ai !== state) return;
        q = fromAI(aiJSON(answer), today);
        note = `질문 문장만 ${aiName(picked)}에게 보내 해석했고, 기록은 보내지 않았어요. 숫자는 이 기기에서 직접 세었어요.`;
      } catch (error) {
        if (ai !== state) return;
        if (error.status === 401 && picked.mode !== 'key') { showLogin(error.message); return; }
        ui.answer = ''; ui.note = error.message;
        return;
      } finally { if (ai === state) { ui.working = false; if (!q) render(); } }
      if (!q) { ui.answer = ''; ui.note = '기록으로 답할 수 있는 질문이 아니에요. AI 탭에서 물어봐 주세요.'; render(); return; }
    }
    ui.answer = compute(q, data.records, now, Somhouse).text;
    ui.note = note;
    render();
  }
  function card() {
    if (shared?.readOnly) return '';
    return `<section class="card ai-help feature-form ask-card" aria-label="기록에 물어보기"><h2>🔎 기록에 물어보기</h2><p class="caption">예: 어제 수유 몇 번 · 지난주 평균 수면 · 이번 주 밤중 수유 · 마지막 대변 언제</p><label class="field">질문<input data-ask-input="1" maxlength="${QUESTION_MAX}" value="${esc(ui.text)}" placeholder="궁금한 것을 적어 주세요"></label><div class="actions"><button type="button" data-ask-run="1"${ui.working ? ' disabled' : ''}>${ui.working ? '해석하는 중…' : '물어보기'}</button></div>${ui.answer ? `<p class="ai-summary-text" role="status">${esc(ui.answer)}</p>` : ''}${ui.note ? `<p class="caption">${esc(ui.note)}</p>` : ''}</section>`;
  }
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('input', event => { if (event.target?.dataset?.askInput) ui.text = String(event.target.value || '').slice(0, QUESTION_MAX); });
    document.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target?.dataset?.askInput) { event.preventDefault(); ask(); } });
  }
  H.register({
    id: 'ask',
    slots: {stats: card},
    reset() { Object.assign(ui, {text: '', answer: '', note: '', working: false}); },
    async click(button) { if (!button.dataset?.askRun) return false; await ask(); return true; },
  });
})(typeof window !== 'undefined' ? window : this);
