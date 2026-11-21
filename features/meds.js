'use strict';
/* "약 먹였어?" between two caregivers: a shared log of medicine and temperature, so the same dose is not given twice.
   The family types the name, the dose and the interval from the pharmacy label or the doctor. Somhouse never calculates,
   suggests or judges a dose or a temperature; it only shows what was recorded and warns about the family's own interval. */
(function (root) {
  const MAX = {name: 40, dose: 40, memo: 200}, EVERY = [1, 72], TEMP = [30, 45], HOME_HOURS = 72, FUTURE_MINUTES = 10;
  const minute = stamp => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stamp || ''); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null; };
  const pad = n => String(n).padStart(2, '0');
  const stampOf = value => { const d = new Date(value * 60000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const sameName = (a, b) => String(a || '').replace(/\s+/g, '').toLowerCase() === String(b || '').replace(/\s+/g, '').toLowerCase();
  const meds = list => list.filter(x => x?.kind === 'med' && x.name && minute(x.at) !== null);
  const hoursOk = v => Number.isFinite(v) && v >= EVERY[0] && v <= EVERY[1];
  // When the family's own interval has passed.
  function nextAt(entry) { return hoursOk(Number(entry.every)) ? stampOf(minute(entry.at) + Math.round(Number(entry.every) * 60)) : ''; }
  // The latest dose of this medicine before `at` whose interval has not passed yet.
  function tooSoon(list, name, at) {
    const when = minute(at), last = meds(list).filter(x => sameName(x.name, name) && minute(x.at) <= when).sort((a, b) => minute(b.at) - minute(a.at))[0];
    if (!last) return null;
    const next = nextAt(last);
    return next && minute(next) > when ? {last, next, agoMinutes: when - minute(last.at)} : null;
  }
  // Each medicine's latest dose, newest first.
  function latest(list, now) {
    const seen = new Map(), current = minute(now);
    for (const x of meds(list).filter(y => minute(y.at) <= current).sort((a, b) => minute(b.at) - minute(a.at))) {
      const key = String(x.name).replace(/\s+/g, '').toLowerCase();
      if (!seen.has(key)) seen.set(key, x);
    }
    return [...seen.values()].map(x => { const next = nextAt(x); return {entry: x, next, wait: Boolean(next) && minute(next) > current, agoMinutes: current - minute(x.at)}; });
  }
  function checkMed({name, dose = '', every = '', at, memo = ''}, now) {
    const clean = String(name || '').trim();
    if (!clean || clean.length > MAX.name) return '약 이름을 입력해 주세요.';
    if (String(dose).length > MAX.dose || String(memo).length > MAX.memo) return '입력이 너무 길어요.';
    if (String(every).trim() !== '' && !hoursOk(Number(every))) return `간격은 ${EVERY[0]}~${EVERY[1]}시간으로 적어 주세요.`;
    return checkTime(at, now);
  }
  function checkTemp({value, at}, now) {
    const number = Number(value);
    if (String(value ?? '').trim() === '' || !Number.isFinite(number) || number < TEMP[0] || number > TEMP[1]) return `체온은 ${TEMP[0]}~${TEMP[1]}℃로 적어 주세요.`;
    return checkTime(at, now);
  }
  function checkTime(at, now) {
    if (minute(at) === null) return '시각을 확인해 주세요.';
    return minute(at) > minute(now) + FUTURE_MINUTES ? '지금보다 늦은 시각은 기록할 수 없어요.' : '';
  }
  const api = {nextAt, tooSoon, latest, checkMed, checkTemp};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  const H = SomhouseFeatures, ui = {tab: 'med', status: ''};
  const entries = () => H.items('meds').filter(x => x && minute(x.at) !== null);
  const consented = () => !root.SomhouseConsent || root.SomhouseConsent.has('health');
  const whenText = v => v.slice(5).replace('-', '/').replace('T', ' ');
  const dayNear = (stamp, now) => (stamp.slice(0, 10) === now.slice(0, 10) ? stamp.slice(11) : whenText(stamp));
  const ago = minutes => (minutes < 1 ? '방금' : `${Somhouse.duration(minutes)} 전`);
  function statusLine(x, now) {
    const who = x.entry.by ? ` · ${esc(shortName(x.entry.by))}` : '', dose = x.entry.dose ? ` ${esc(x.entry.dose)}` : '';
    const next = x.next ? (x.wait ? `<span class="badge warn">적어 둔 간격 ${esc(dayNear(x.next, now))}까지</span>` : '<span class="badge">적어 둔 간격 지남</span>') : '';
    return `<li><strong>💊 ${esc(x.entry.name)}</strong>${dose} · ${esc(ago(x.agoMinutes))}${who} ${next}</li>`;
  }
  function homeCard() {
    if (shared?.readOnly) return '';
    const now = Somhouse.localDateTime(), recent = latest(entries(), now).filter(x => x.agoMinutes <= HOME_HOURS * 60);
    const temp = entries().filter(x => x.kind === 'temp' && minute(x.at) <= minute(now)).sort((a, b) => minute(b.at) - minute(a.at))[0];
    const recentTemp = temp && minute(now) - minute(temp.at) <= HOME_HOURS * 60;
    if (!recent.length && !recentTemp) return '';
    return `<section class="card meds-card" aria-label="투약"><h2>💊 투약 · 체온</h2><ul>${recent.map(x => statusLine(x, now)).join('')}${recentTemp ? `<li>🌡️ ${esc(temp.value)}℃ · ${esc(ago(minute(now) - minute(temp.at)))}</li>` : ''}</ul><div class="actions"><button type="button" class="secondary small" data-page="meds">기록하기·전체 보기</button></div></section>`;
  }
  const entryButton = () => (shared?.readOnly ? '' : '<div class="quick"><button type="button" class="secondary" data-page="meds">💊 투약·체온 기록</button></div>');
  function form(now) {
    const names = [...new Map(entries().filter(x => x.kind === 'med').map(x => [String(x.name).replace(/\s+/g, '').toLowerCase(), x.name])).values()];
    const last = name => meds(entries()).filter(x => sameName(x.name, name)).sort((a, b) => minute(b.at) - minute(a.at))[0];
    const repeat = names.slice(0, 4).map(n => `<button type="button" class="secondary small" data-med-again="${esc(n)}">${esc(n)}${last(n)?.dose ? ` ${esc(last(n).dose)}` : ''}</button>`).join('');
    const tabs = [['med', '💊 약'], ['temp', '🌡️ 체온']].map(([id, label]) => `<button type="button" class="${ui.tab === id ? '' : 'secondary '}small" data-med-tab="${id}" aria-pressed="${ui.tab === id}">${label}</button>`).join('');
    const time = `<label class="field">시각<input id="med-at" type="datetime-local" value="${esc(now)}"></label>`;
    const body = ui.tab === 'temp'
      ? `<label class="field">체온 (℃)<input id="med-value" type="number" inputmode="decimal" step="0.1" min="${TEMP[0]}" max="${TEMP[1]}" placeholder="예: 37.2"></label>${time}`
      : `${repeat ? `<p class="caption">자주 쓰는 약</p><div class="quick">${repeat}</div>` : ''}<label class="field">약 이름<input id="med-name" maxlength="${MAX.name}" list="med-names" placeholder="약 봉투에 적힌 이름"><datalist id="med-names">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist></label><label class="field">먹인 양 (선택)<input id="med-dose" maxlength="${MAX.dose}" placeholder="약 봉투에 적힌 대로, 예: 3ml"></label><label class="field">복용 간격 (시간, 선택)<input id="med-every" type="number" inputmode="numeric" min="${EVERY[0]}" max="${EVERY[1]}" placeholder="약 봉투나 의사·약사 안내대로"></label>${time}`;
    return `<section class="card feature-form" aria-label="투약·체온 기록"><div class="quick">${tabs}</div>${body}<div class="actions"><button type="button" data-med-save="1">기록</button></div>${ui.status ? `<p class="caption" role="status">${esc(ui.status)}</p>` : ''}<p class="caption">양과 간격은 약 봉투나 의사·약사의 안내대로 적어 주세요. 솜하우스는 용량을 계산하거나 추천하지 않고, 체온을 판단하지 않아요.</p></section>`;
  }
  function pageView() {
    if (!consented()) return '<h1>투약·체온</h1><div class="card empty">이 기능을 쓰려면 먼저 건강 관련 기록 처리에 동의해 주세요.</div><button class="plain" data-page="home">← 홈으로</button>';
    const now = Somhouse.localDateTime(), state = latest(entries(), now);
    const rows = [...entries()].sort((a, b) => minute(b.at) - minute(a.at)).slice(0, 60).map(x => `<div class="item"><strong>${x.kind === 'temp' ? `🌡️ ${esc(x.value)}℃` : `💊 ${esc(x.name)}${x.dose ? ` ${esc(x.dose)}` : ''}`}</strong><p>${esc(x.at.replace('T', ' '))}${x.every ? ` · ${esc(x.every)}시간 간격` : ''}${x.by ? ` · ${esc(shortName(x.by))}` : ''}</p><button type="button" class="plain small" data-med-remove="${esc(x.id)}">지우기</button></div>`).join('');
    return `<h1>투약·체온</h1>${state.length ? `<section class="card meds-card"><h2>지금 상태</h2><ul>${state.map(x => statusLine(x, now)).join('')}</ul></section>` : ''}${shared.readOnly ? '' : form(now)}<h2 class="section-head">기록</h2>${rows || '<div class="card empty">아직 기록이 없어요.</div>'}<div class="actions no-print"><button type="button" class="secondary" data-med-print="1">인쇄 · PDF 저장</button><button class="plain" data-page="home">← 홈으로</button></div>`;
  }
  async function saveEntry() {
    const now = Somhouse.localDateTime(), at = String(document.querySelector('#med-at')?.value || '').slice(0, 16);
    if (ui.tab === 'temp') {
      const value = String(document.querySelector('#med-value')?.value || '').trim(), problem = checkTemp({value, at}, now);
      if (problem) { ui.status = problem; render(); return; }
      if (await H.save('meds', {id: newId(), kind: 'temp', at, value: String(Number(value)), by: shared.username})) { ui.status = `체온 ${Number(value)}℃를 기록했어요.`; render(); }
      return;
    }
    const name = String(document.querySelector('#med-name')?.value || '').trim(), dose = String(document.querySelector('#med-dose')?.value || '').trim(), every = String(document.querySelector('#med-every')?.value || '').trim();
    const problem = checkMed({name, dose, every, at}, now);
    if (problem) { ui.status = problem; render(); return; }
    const soon = tooSoon(entries(), name, at);
    if (soon && !confirm(`⚠️ ${soon.last.name}을(를) ${Somhouse.duration(soon.agoMinutes)} 전에 이미 기록했어요${soon.last.by ? ` (${shortName(soon.last.by)})` : ''}.\n적어 둔 간격은 ${soon.last.every}시간이고, ${soon.next.replace('T', ' ')} 이후예요.\n그래도 기록할까요?`)) { ui.status = '기록하지 않았어요.'; render(); return; }
    if (await H.save('meds', {id: newId(), kind: 'med', at, name, dose, ...(every ? {every: String(Number(every))} : {}), by: shared.username})) { ui.status = `${name}을(를) 기록했어요. 가족 휴대폰에도 보여요.`; render(); }
  }
  H.register({
    id: 'meds',
    init() { H.style('meds', '.meds-card ul{list-style:none;margin:0 0 6px;padding:0}.meds-card li{padding:6px 0}.meds-card h2{margin:0 0 4px}'); },
    slots: {home: homeCard, records: entryButton},
    pages: {meds: {title: '투약·체온', view: pageView}},
    reset() { Object.assign(ui, {tab: 'med', status: ''}); },
    async click(button) {
      const d = button.dataset || {};
      if (d.medTab) { ui.tab = d.medTab === 'temp' ? 'temp' : 'med'; ui.status = ''; render(); return true; }
      if (d.medSave) { await saveEntry(); return true; }
      if (d.medPrint) { if (typeof print === 'function') print(); return true; }
      if (d.medAgain) {
        const last = meds(entries()).filter(x => sameName(x.name, d.medAgain)).sort((a, b) => minute(b.at) - minute(a.at))[0];
        const set = (selector, value) => { const el = document.querySelector(selector); if (el) el.value = value || ''; };
        set('#med-name', last?.name); set('#med-dose', last?.dose); set('#med-every', last?.every); set('#med-at', Somhouse.localDateTime());
        return true;
      }
      if (d.medRemove) {
        const x = entries().find(y => y.id === d.medRemove);
        if (x && confirm('이 기록을 지울까요?') && await H.remove('meds', x.id)) render();
        return true;
      }
      return false;
    },
  });
})(typeof window !== 'undefined' ? window : this);
