'use strict';
/* One line becomes records with no AI, no API key and no network: "새벽 3시 분유 120 먹고 4시에 잠".
   The rules run on this device and only ever propose; nothing is saved until a person presses save.
   Anything they cannot read stays out rather than being guessed. The microphone listens only while tapped. */
(function (root) {
  const INPUT_MAX = 200, FUTURE_MINUTES = 10, OPEN_SLEEP_MINUTES = 16 * 60;
  const pad = n => String(n).padStart(2, '0');
  const stampOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const dateOf = stamp => new Date(stamp + ':00');
  const plus = (stamp, minutes) => stampOf(new Date(dateOf(stamp).getTime() + minutes * 60000));
  const NUMBERS = {한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12};
  // "세시 반" as a speech recognizer writes it becomes "3시 30분".
  function normalize(text) {
    return String(text || '').slice(0, INPUT_MAX).replace(/\s+/g, ' ').trim()
      .replace(/(열두|열한|열|한|두|세|네|다섯|여섯|일곱|여덟|아홉)\s*시(?=[^간]|$)/g, (_, word) => `${NUMBERS[word]}시`)
      .replace(/(\d)\s*시\s*반/g, '$1시 30분')
      .replace(/밀리리터|밀리|미리|씨씨|시시/g, 'ml').replace(/(\d\s*)cc\b/gi, '$1ml');
  }
  // Clauses end at punctuation or after a verb form that continues ("먹고", "했고", "자고"...).
  function clauses(text) {
    return text.replace(/(먹고|먹었고|먹이고|먹였고|마시고|했고|하고|쌌고|싸고|갈고|갈았고|자고|잤고|자서|잠들고|잠들었고|잠들어서|깨고|깼고|재우고|재웠고)(?=\s)/g, '$1\n')
      .split(/[\n,，.。;]|그리고|그 다음에?|다음에/).map(x => x.trim()).filter(Boolean);
  }
  const RELATIVE = /(\d+)\s*시간(?:\s*(\d+)\s*분)?\s*전|(\d+)\s*분\s*전/;
  const CLOCK = /(?:(새벽|아침|오전|낮|점심|오후|저녁|밤)\s*)?(\d{1,2})\s*시(?!간)(?:\s*(\d{1,2})\s*분(?!\s*전))?|(?:(새벽|아침|오전|낮|점심|오후|저녁|밤)\s*)?\b(\d{1,2}):(\d{2})\b/;
  const AM = ['새벽', '아침', '오전'], PM = ['낮', '점심', '오후', '저녁', '밤'];
  // Candidate hours in 24h for a spoken hour and part of the day.
  function hours(hour, part) {
    if (hour > 24 || hour < 0) return [];
    if (hour > 12) return [hour % 24];
    if (AM.includes(part)) return [hour % 12];
    if (part === '밤') return hour === 12 ? [0] : hour >= 6 ? [hour + 12] : [hour];  // "밤 2시" is after midnight.
    if (PM.includes(part)) return [hour === 12 ? 12 : hour + 12];
    return hour === 12 ? [0, 12] : hour === 0 ? [0] : [hour, hour + 12];
  }
  // A clock time with no date: after the previous clause if there is one (the story moves forward), else the latest past time.
  function resolveClock(list, minute, now, after, dayShift, today = false) {
    const candidates = [];
    if (today) {
      const on = list.map(h => stampOf(new Date(dateOf(now).getFullYear(), dateOf(now).getMonth(), dateOf(now).getDate(), h, minute))).sort();
      return on.filter(x => x <= plus(now, FUTURE_MINUTES)).pop() || on[0] || '';
    }
    for (const back of [0, 1, 2]) for (const h of list) {
      const day = new Date(dateOf(now).getFullYear(), dateOf(now).getMonth(), dateOf(now).getDate() - back - dayShift, h, minute);
      candidates.push(stampOf(day));
    }
    if (after) {
      const ahead = [...candidates, ...list.map(h => stampOf(new Date(dateOf(now).getFullYear(), dateOf(now).getMonth(), dateOf(now).getDate() + 1, h, minute)))]
        .filter(x => x >= after && (dateOf(x) - dateOf(after)) <= 16 * 3600000).sort();
      if (ahead.length) return ahead[0];
    }
    const past = candidates.filter(x => x <= plus(now, FUTURE_MINUTES)).sort();
    if (dayShift) {
      // "어제 3시": the candidates of that very day.
      const target = stampOf(new Date(dateOf(now).getFullYear(), dateOf(now).getMonth(), dateOf(now).getDate() - dayShift)).slice(0, 10);
      const onDay = candidates.filter(x => x.startsWith(target)).sort();
      return onDay[onDay.length - 1] || past[past.length - 1] || '';
    }
    return past[past.length - 1] || '';
  }
  // Takes the first time expression out of a clause. Returns {at, rest, had}.
  function readTime(clause, now, after) {
    let rest = clause, dayShift = 0, today = false;
    if (/그저께|그제/.test(rest)) { dayShift = 2; rest = rest.replace(/그저께|그제/, ' '); }
    else if (/어제/.test(rest)) { dayShift = 1; rest = rest.replace('어제', ' '); }
    else if (/오늘/.test(rest)) { today = true; rest = rest.replace('오늘', ' '); }
    const relative = rest.match(RELATIVE);
    if (relative) {
      const minutes = relative[3] !== undefined ? Number(relative[3]) : Number(relative[1]) * 60 + Number(relative[2] || 0);
      return {at: plus(now, -minutes), rest: rest.replace(relative[0], ' '), had: true};
    }
    const clock = rest.match(CLOCK);
    if (clock) {
      const part = clock[1] || clock[4], hour = Number(clock[2] ?? clock[5]), minute = Number(clock[3] ?? clock[6] ?? 0);
      if (minute < 60) {
        const list = hours(hour, part);
        const at = list.length ? resolveClock(list, minute, now, dayShift || today ? '' : after, dayShift, today) : '';
        return {at, rest: rest.replace(clock[0], ' '), had: true, bad: !at, dated: Boolean(dayShift || today)};
      }
    }
    if (/방금|지금|막\s/.test(rest)) return {at: now, rest: rest.replace(/방금|지금/, ' '), had: true};
    if (dayShift) return {at: '', rest, had: true, bad: true};
    return {at: '', rest, had: false};
  }
  const duration = text => {
    const m = text.match(/(\d+)\s*시간(?:\s*(\d+)\s*분)?(?!\s*전)/), n = text.match(/(\d+)\s*분(?!\s*전)/);
    return m ? Number(m[1]) * 60 + Number(m[2] || 0) : n ? Number(n[1]) : null;
  };
  // What the family usually writes for an amount with no stated kind.
  function usualKind(records, unit) {
    const fits = x => x.type === 'feeding' && (unit === 'ml' ? /ml$/i.test(x.amount || '') : /분$/.test(x.amount || ''));
    return [...records].filter(fits).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.category || (unit === 'ml' ? '분유' : '모유');
  }
  function feedingFrom(rest, records) {
    const word = rest.match(/분유|모유|직수|젖|혼합|수유|맘마/)?.[0];
    if (!word) return null;
    let category = word === '직수' || word === '젖' ? '모유' : word === '분유' || word === '모유' || word === '혼합' ? word : '';
    const notes = [], minutes = rest.match(/(\d+)\s*분/), ml = rest.match(/(\d+(?:\.\d+)?)\s*ml/i), plain = rest.match(/(?:^|\s|[가-힣])(\d{2,3})(?=\s|[가-힣]|$)/);
    let amount = '';
    if (ml) amount = `${ml[1]}ml`;
    else if (minutes) amount = `${minutes[1]}분`;
    else if (plain && category !== '모유') amount = `${plain[1]}ml`;
    if (!category) {
      category = amount ? usualKind(records, amount.endsWith('ml') ? 'ml' : '분') : '분유';
      notes.push(`종류를 말하지 않아 ${category}로 넣었어요`);
    }
    return {type: 'feeding', category, amount, notes};
  }
  function diaperFrom(rest) {
    const pee = /소변|오줌|쉬(?!는)/.test(rest), poo = /대변|응가|똥|변을|응아/.test(rest);
    if (!pee && !poo && !/기저귀/.test(rest)) return null;
    return {type: 'diaper', category: pee && poo ? '둘 다' : poo ? '대변' : pee ? '소변' : ''};
  }
  const SLEEP = /낮잠|밤잠|수면|잠들|잠듦|잠|잤|재웠|재움|자기 시작|취침/, WAKE = /깼|깸|기상|일어났|일어남|깨어/;
  function latestOpenSleep(records, at) {
    return records.filter(x => x.type === 'sleep' && !x.end && x.date && x.date <= at && (minutesBetween(x.date, at) <= OPEN_SLEEP_MINUTES))
      .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  }
  const minutesBetween = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 60000);
  const sleepKind = (word, at) => word.includes('낮잠') ? '낮잠' : word.includes('밤잠') ? '밤잠' : Number(at.slice(11, 13)) >= 7 && Number(at.slice(11, 13)) < 19 ? '낮잠' : '밤잠';

  function parse(text, now, records = []) {
    const items = [];
    let after = '';
    // A clock time with no date can land on an earlier day: say so, so a wrong guess is easy to spot.
    const dayNote = (time, stamp) => time.had && !time.dated && stamp.slice(0, 10) !== now.slice(0, 10) ? [`${Number(stamp.slice(5, 7))}/${Number(stamp.slice(8, 10))} ${stamp.slice(11)}로 넣었어요`] : [];
    const add = (record, problems, notes = []) => { items.push({record, problems, notes}); };
    for (const clause of clauses(normalize(text))) {
      const time = readTime(clause, now, after), rest = time.rest;
      const problems = time.bad ? ['시각을 확인해 주세요'] : [];
      const at = time.at || now;
      if (time.at && time.at > plus(now, FUTURE_MINUTES)) problems.push('지금보다 늦은 시각이에요');
      const feeding = feedingFrom(rest, records);
      if (feeding) {
        const {notes, ...fields} = feeding;
        if (!fields.amount) problems.push('양을 입력해 주세요');
        if (!time.had) notes.unshift('지금 시각으로 넣었어요');
        add({...fields, date: at, memo: ''}, problems, [...dayNote(time, at), ...notes]);
        after = at;
        continue;
      }
      const diaper = diaperFrom(rest);
      if (diaper) {
        if (!diaper.category) problems.push('종류를 골라 주세요');
        add({...diaper, date: at, memo: ''}, problems, time.had ? dayNote(time, at) : ['지금 시각으로 넣었어요']);
        after = at;
        continue;
      }
      if (WAKE.test(rest) && !/낮잠|밤잠/.test(rest)) {
        const previous = [...items].reverse().find(x => x.record.type === 'sleep' && !x.record.end);
        if (previous) {
          if (at > previous.record.date) previous.record.end = at; else previous.problems.push('깬 시각을 확인해 주세요');
          after = at;
          continue;
        }
        const open = latestOpenSleep(records, at);
        if (open && at > open.date) add({...open, end: at}, problems, ['열려 있던 수면을 끝내요']);
        else add({type: 'sleep', date: at, end: '', category: sleepKind('', at), memo: ''}, [...problems, '잠든 시각을 확인해 주세요'], []);
        after = at;
        continue;
      }
      if (SLEEP.test(rest)) {
        const length = duration(rest);
        let start = at, end = '', notes = [];
        if (length && !time.had) { start = plus(now, -length); end = now; notes = ['방금 깬 것으로 넣었어요']; }
        else if (length) end = plus(at, length);
        if (end && end > plus(now, FUTURE_MINUTES)) problems.push('깬 시각이 지금보다 늦어요');
        if (!time.had && !length) notes = ['지금 시각으로 넣었어요'];
        add({type: 'sleep', date: start, end, category: sleepKind(rest, start), memo: ''}, problems, [...dayNote(time, start), ...notes]);
        after = end || start;
      }
    }
    return items.slice(0, 10);
  }
  const api = {parse, normalize, clauses};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.SomhouseQuickText = api;

  const H = SomhouseFeatures, ui = {text: '', items: null, status: '', listening: false};
  const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;
  function listen() {
    if (!Recognition || ui.listening) return;
    const recognizer = new Recognition();
    recognizer.lang = 'ko-KR'; recognizer.interimResults = false; recognizer.maxAlternatives = 1;
    ui.listening = true; ui.status = '듣고 있어요… 말씀해 주세요.'; render();
    recognizer.onresult = event => { ui.text = String(event.results?.[0]?.[0]?.transcript || '').slice(0, INPUT_MAX); read(); };
    recognizer.onerror = event => { ui.status = event.error === 'not-allowed' ? '마이크 권한을 허용해 주세요.' : '잘 듣지 못했어요. 다시 눌러 주세요.'; };
    recognizer.onend = () => { ui.listening = false; if (!editingScreen()) render(); };
    recognizer.start();
  }
  function read() {
    const list = parse(ui.text, Somhouse.localDateTime(), data.records);
    ui.items = list.length ? list : null;
    ui.status = list.length ? '내용을 확인하고 저장해 주세요. 표시가 있는 항목은 고쳐서 저장해요.'
      : ui.text.trim() ? '기록으로 읽지 못했어요. 예처럼 수유·수면·기저귀와 시각을 적어 주세요.' : '기록할 내용을 적어 주세요.';
    render();
  }
  function line(r) {
    return r.type === 'diaper' && !r.category ? '🧷 기저귀' : desc(r, 'records');
  }
  function card() {
    if (shared?.readOnly) return '';
    const rows = (ui.items || []).map((x, i) => {
      const flags = [...x.problems.map(p => `<span class="badge warn">${esc(p)}</span>`), ...x.notes.map(n => `<span class="badge">${esc(n)}</span>`)].join(' ');
      return `<div class="ai-proposal"><p><strong>${line(x.record)}</strong><br><span class="caption">${esc(x.record.date.replace('T', ' '))}</span>${flags ? `<br>${flags}` : ''}</p><div class="actions"><button type="button" class="secondary small" data-qt-edit="${i}">${x.problems.length ? '고쳐서 저장' : '고치기'}</button><button type="button" class="plain small" data-qt-drop="${i}">빼기</button></div></div>`;
    }).join('');
    const ready = (ui.items || []).filter(x => !x.problems.length).length;
    const save = ui.items ? `<div class="actions">${ready ? `<button type="button" data-qt-save="1">${ready}건 저장</button>` : ''}<button type="button" class="plain" data-qt-cancel="1">모두 취소</button></div>` : '';
    const mic = Recognition ? `<button type="button" class="secondary" data-qt-mic="1"${ui.listening ? ' disabled' : ''} aria-label="말로 입력">🎤 ${ui.listening ? '듣는 중' : '말하기'}</button>` : '';
    return `<details class="card ai-help feature-form quicktext"${ui.text || ui.items ? ' open' : ''}><summary><strong>✍️ 한 줄로 기록</strong> <span class="caption">AI 키 없이 이 기기에서</span></summary><p class="caption">예: 새벽 3시 분유 120 먹고 4시에 잠 · 낮잠 40분 · 10분 전 응가</p><textarea data-qt-input="1" maxlength="${INPUT_MAX}" placeholder="있었던 일을 편하게 적어 주세요">${esc(ui.text)}</textarea><div class="actions ai-help-actions">${mic}<button type="button" data-qt-read="1">정리하기</button></div>${Recognition ? '<p class="caption">🎤는 누른 뒤 말하는 동안만 듣고, 음성은 브라우저의 음성 인식 서비스로 전송될 수 있어요. 녹음을 저장하지 않아요.</p>' : ''}${ui.status ? `<p class="caption" role="status">${esc(ui.status)}</p>` : ''}${rows}${save}</details>`;
  }
  async function saveAll() {
    let saved = 0;
    for (const x of (ui.items || []).filter(y => !y.problems.length)) {
      if (!await changeItem('records', {id: x.record.id || newId(), ...x.record})) break;
      saved++; ui.items = ui.items.filter(y => y !== x);
    }
    if (saved) {
      ui.status = `${saved}건 저장했어요.${ui.items.length ? ' 남은 항목은 고쳐서 저장해 주세요.' : ''}`;
      if (!ui.items.length) { ui.items = null; ui.text = ''; }
    }
    render();
  }
  if (typeof document.addEventListener === 'function') document.addEventListener('input', event => {
    if (event.target?.dataset?.qtInput) ui.text = String(event.target.value || '').slice(0, INPUT_MAX);
  });
  H.register({
    id: 'quicktext',
    slots: {home: card},
    reset() { Object.assign(ui, {text: '', items: null, status: '', listening: false}); },
    async click(button) {
      const d = button.dataset || {};
      if (d.qtRead) { read(); return true; }
      if (d.qtMic) { listen(); return true; }
      if (d.qtSave) { await saveAll(); return true; }
      if (d.qtCancel) { ui.items = null; ui.status = ''; render(); return true; }
      if (d.qtDrop !== undefined) { ui.items = ui.items.filter((_, i) => i !== Number(d.qtDrop)); if (!ui.items.length) ui.items = null; render(); return true; }
      if (d.qtEdit !== undefined) {
        const x = ui.items?.[Number(d.qtEdit)];
        if (!x) return true;
        ui.items = ui.items.filter(y => y !== x); if (!ui.items.length) ui.items = null;
        if (x.record.id) openForm(x.record.type, data.records.find(r => r.id === x.record.id) ? x.record : null, {...x.record});
        else openForm(x.record.type, null, {...x.record});
        return true;
      }
      return false;
    },
  });
})(typeof window !== 'undefined' ? window : this);
