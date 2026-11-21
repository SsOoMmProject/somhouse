'use strict';
/* What is due for this baby and when: the national standard vaccination schedule and infant health checkups, worked out
   from the birth date. It is a calendar, not advice: it copies the published table, cannot see the baby's condition, and
   sends any delayed dose back to the doctor, as the schedule itself instructs.
   Sources: 질병관리청 표준예방접종일정표(2026), 질병관리청·국민건강보험공단 영유아 건강검진 안내 (checked 2026-11-21). */
(function (root) {
  const SOURCE_YEAR = 2026, SOON_DAYS = 30;
  const M = (from, until) => ({months: [from, until]});
  const twoFour = [['1차', '2개월', M(2, 3)], ['2차', '4개월', M(4, 5)]];
  const VACCINES = [
    {id: 'bcg', name: '결핵(BCG)', doses: [['1차', '생후 4주 이내', {days: [0, 28]}]]},
    {id: 'hepb', name: 'B형간염', doses: [['1차', '출생 시', M(0, 1)], ['2차', '1개월', M(1, 2)], ['3차', '6개월', M(6, 7)]]},
    {id: 'dtap', name: '디프테리아·파상풍·백일해', doses: [...twoFour, ['3차', '6개월', M(6, 7)], ['4차', '15~18개월', M(15, 19)], ['5차', '4~6세', M(48, 84)], ['6차', '11~12세', M(132, 156)]]},
    {id: 'ipv', name: '폴리오', doses: [...twoFour, ['3차', '6~18개월', M(6, 19)], ['4차', '4~6세', M(48, 84)]]},
    {id: 'hib', name: 'b형헤모필루스인플루엔자', doses: [...twoFour, ['3차', '6개월', M(6, 7)], ['4차', '12~15개월', M(12, 16)]]},
    {id: 'pcv', name: '폐렴구균', doses: [...twoFour, ['3차', '6개월', M(6, 7)], ['4차', '12~15개월', M(12, 16)]]},
    {id: 'rv', name: '로타바이러스', choice: {rv1: {label: 'RV1 (2회)', doses: twoFour}, rv5: {label: 'RV5 (3회)', doses: [...twoFour, ['3차', '6개월', M(6, 7)]]}}},
    {id: 'mmr', name: '홍역·유행성이하선염·풍진', doses: [['1차', '12~15개월', M(12, 16)], ['2차', '4~6세', M(48, 84)]]},
    {id: 'var', name: '수두', doses: [['1차', '12~15개월', M(12, 16)]]},
    {id: 'hepa', name: 'A형간염', doses: [['1차', '12~35개월', M(12, 36)], ['2차', '12~35개월', M(12, 36)]]},
    {id: 'je', name: '일본뇌염', choice: {
      ijev: {label: '불활성화 백신 (5회)', doses: [['1차', '12~23개월', M(12, 24)], ['2차', '12~23개월', M(12, 24)], ['3차', '24~35개월', M(24, 36)], ['4차', '6세', M(72, 84)], ['5차', '12세', M(144, 156)]]},
      ljev: {label: '약독화 생백신 (2회)', doses: [['1차', '12~23개월', M(12, 24)], ['2차', '24~35개월', M(24, 36)]]},
    }},
    {id: 'hpv', name: '사람유두종바이러스', doses: [['1차', '11~12세', M(132, 156)], ['2차', '11~12세', M(132, 156)]]},
  ];
  const CHECKUPS = [
    ['1차', '생후 14~35일', {days: [14, 35]}], ['2차', '4~6개월', M(4, 7)], ['3차', '9~12개월', M(9, 13)], ['4차', '18~24개월', M(18, 25)],
    ['5차', '30~36개월', M(30, 37)], ['6차', '42~48개월', M(42, 49)], ['7차', '54~60개월', M(54, 61)], ['8차', '66~71개월', M(66, 72)],
  ].map(([label, when, window]) => ({id: 'check-' + label[0], group: 'check', name: '영유아 건강검진', label, when, window}));
  const DENTAL = [['1차', '18~29개월', M(18, 30)], ['2차', '30~41개월', M(30, 42)], ['3차', '42~53개월', M(42, 54)], ['4차', '54~65개월', M(54, 66)]]
    .map(([label, when, window]) => ({id: 'dental-' + label[0], group: 'check', name: '영유아 구강검진', label, when, window}));

  const utc = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const addDays = (day, n) => new Date(utc(day) + n * 86400000).toISOString().slice(0, 10);
  function addMonths(day, months) {
    const [y, m, d] = day.split('-').map(Number), last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
  }
  // First and last day of a dose's window. "6개월" runs from the day the baby turns 6 months to the day before 7 months.
  function windowOf(item, birth) {
    if (item.window.days) return {start: addDays(birth, item.window.days[0]), end: addDays(birth, item.window.days[1])};
    return {start: addMonths(birth, item.window.months[0]), end: addDays(addMonths(birth, item.window.months[1]), -1)};
  }
  // A vaccine with two products follows the family's choice; until then only the doses both share are listed.
  function plan(choices = {}) {
    const list = [];
    for (const v of VACCINES) {
      let doses = v.doses, pending = false;
      if (v.choice) {
        const picked = v.choice[choices[v.id]];
        if (picked) doses = picked.doses;
        else {
          const all = Object.values(v.choice).map(x => x.doses);
          doses = all[0].filter((d, i) => all.every(other => other[i] && other[i][0] === d[0] && other[i][1] === d[1]));
          pending = true;
        }
      }
      doses.forEach(([label, when, window], i) => list.push({id: `${v.id}-${i + 1}`, group: 'vaccine', vaccine: v.id, name: v.name, label, when, window, pending}));
    }
    return [...list, ...CHECKUPS, ...DENTAL];
  }
  function statusOf(item, birth, today, done) {
    if (done) return 'done';
    const {start, end} = windowOf(item, birth);
    if (today > end) return 'past';
    if (today >= start) return 'now';
    return utc(start) - utc(today) <= SOON_DAYS * 86400000 ? 'soon' : 'later';
  }
  function schedule(birth, today, doneIds = new Set(), choices = {}) {
    return plan(choices).map(item => ({...item, ...windowOf(item, birth), status: statusOf(item, birth, today, doneIds.has(item.id))}))
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  }
  const api = {VACCINES, CHECKUPS, DENTAL, SOURCE_YEAR, plan, windowOf, statusOf, schedule};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  const H = SomhouseFeatures, ui = {child: '', status: '', showLater: false};
  const consented = () => !root.SomhouseConsent || root.SomhouseConsent.has('health');
  const baby = () => { const list = H.profiles(); return list.find(x => x.id === ui.child) || list[0] || null; };
  const stored = () => H.items('vaccines').filter(x => x && typeof x.id === 'string');
  const doneId = (child, dose) => `done:${child.id}:${dose}`, choiceId = (child, vaccine) => `choice:${child.id}:${vaccine}`;
  const doneSet = child => new Set(stored().filter(x => x.id.startsWith(`done:${child.id}:`)).map(x => x.id.split(':')[2]));
  const choices = child => Object.fromEntries(stored().filter(x => x.id.startsWith(`choice:${child.id}:`)).map(x => [x.id.split(':')[2], x.value]));
  const today = () => Somhouse.localDateTime().slice(0, 10);
  const listFor = child => schedule(child.birth, today(), doneSet(child), choices(child));
  const short = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  const range = x => (x.start === x.end ? x.start : `${x.start.slice(0, 4) === x.end.slice(0, 4) ? `${x.start.slice(0, 4)}년 ${short(x.start)}~${short(x.end)}` : `${x.start}~${x.end}`}`);
  const title = x => `${x.group === 'vaccine' ? '예방접종' : '검진'}: ${x.name} ${x.label}`;
  const planned = x => data.schedule.some(s => s.title === title(x));
  function row(x) {
    const tag = {past: '<span class="badge warn">표준 시기 지남</span>', now: '<span class="badge dday soon">지금 시기</span>', soon: '<span class="badge dday">곧</span>', done: '<span class="badge">완료</span>'}[x.status] || '';
    const note = x.status === 'past' ? (x.group === 'vaccine' ? '<br><span class="caption">접종했다면 ‘했어요’를, 아니면 이후 일정을 의사와 상의해 주세요.</span>' : '<br><span class="caption">검진 기간은 공단에서 확인해 주세요.</span>') : '';
    const actions = shared.readOnly ? '' : x.status === 'done' ? `<button type="button" class="plain small" data-vax-undo="${esc(x.id)}">되돌리기</button>` : `<button type="button" class="secondary small" data-vax-done="${esc(x.id)}">✓ 했어요</button>${planned(x) ? '<span class="caption">일정에 있어요</span>' : `<button type="button" class="plain small" data-vax-plan="${esc(x.id)}">일정에 넣기</button>`}`;
    return `<div class="item"><strong>${esc(x.name)} ${esc(x.label)}</strong> ${tag}<p>${esc(x.when)} · ${esc(range(x))}${note}</p><div class="actions">${actions}</div></div>`;
  }
  function chooser(child) {
    const picked = choices(child);
    return VACCINES.filter(v => v.choice).map(v => `<p class="caption">${esc(v.name)} 백신 종류: ${Object.entries(v.choice).map(([id, c]) => `<button type="button" class="${picked[v.id] === id ? '' : 'secondary '}small" data-vax-choice="${v.id}:${id}" aria-pressed="${picked[v.id] === id}">${esc(c.label)}</button>`).join(' ')}${picked[v.id] ? '' : ' <span>고르면 다음 차수까지 보여요</span>'}</p>`).join('');
  }
  function homeCard() {
    if (shared?.readOnly || !consented()) return '';
    const child = baby();
    if (!child) return '';
    const list = listFor(child), due = list.filter(x => x.status === 'now' || x.status === 'soon').slice(0, 3);
    if (!due.length) return '';
    return `<section class="card vax-card" aria-label="다가오는 접종·검진"><h2>💉 다가오는 접종·검진</h2><ul>${due.map(x => `<li><strong>${esc(x.name)} ${esc(x.label)}</strong> ${x.status === 'now' ? '<span class="badge dday soon">지금 시기</span>' : `<span class="badge dday">${esc(short(x.start))}부터</span>`}</li>`).join('')}</ul><div class="actions"><button type="button" class="secondary small" data-page="vaccines">전체 보기</button></div></section>`;
  }
  const entry = () => (shared?.readOnly || !consented() ? '' : '<div class="quick"><button type="button" class="secondary" data-page="vaccines">💉 예방접종·검진 일정</button></div>');
  function pageView() {
    if (!consented()) return '<h1>예방접종·검진</h1><div class="card empty">이 기능을 쓰려면 먼저 건강 관련 기록 처리에 동의해 주세요.</div><button class="plain" data-page="schedule">← 일정으로</button>';
    const child = baby(), profile = H.profileCard('태어난 날로 접종·검진 시기를 계산해요.');
    if (!child) return `<h1>예방접종·검진</h1>${profile}<button class="plain" data-page="schedule">← 일정으로</button>`;
    const list = listFor(child), of = s => list.filter(x => x.status === s), old = Number(today().slice(0, 4)) > SOURCE_YEAR;
    const pick = H.profiles().length > 1 ? `<div class="quick">${H.profiles().map(x => `<button type="button" class="${x.id === child.id ? '' : 'secondary '}small" data-vax-child="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>` : '';
    const past = of('past'), bulk = past.length > 1 && !shared.readOnly ? `<div class="actions"><button type="button" class="secondary small" data-vax-all="1">지난 시기 ${past.length}건 모두 했어요</button></div>` : '';
    const section = (name, items) => (items.length ? `<h2 class="section-head">${name} ${items.length}건</h2>${items.map(row).join('')}` : '');
    const later = of('later'), done = of('done');
    return `<h1>예방접종·검진</h1>${profile}${pick}${old ? `<div class="card checks-card"><p><strong>일정표를 다시 확인해 주세요</strong><br>이 화면은 ${SOURCE_YEAR}년 표 기준이에요. 새 표가 나왔을 수 있어요.</p></div>` : ''}<p class="caption">질병관리청 ${SOURCE_YEAR}년 표준예방접종일정표와 영유아 건강검진 시기를 태어난 날에 맞춘 달력이에요. 아기 상태나 이전 접종에 따라 달라질 수 있으니 실제 접종은 소아과에서 확인해 주세요. <a href="https://nip.kdca.go.kr/irhp/infm/goVcntInfo.do?menuLv=1&menuCd=115" target="_blank" rel="noopener noreferrer">예방접종도우미 ↗</a> · <a href="https://www.nhis.or.kr/" target="_blank" rel="noopener noreferrer">건강보험공단 ↗</a></p>${chooser(child)}${ui.status ? `<p class="caption" role="status">${esc(ui.status)}</p>` : ''}${past.length ? `<h2 class="section-head">표준 시기 지남 ${past.length}건</h2>${bulk}${past.map(row).join('')}` : ''}${section('지금 시기', of('now'))}${section('곧', of('soon'))}${later.length ? `<details class="past"${ui.showLater ? ' open' : ''}><summary>나중에 ${later.length}건</summary>${later.map(row).join('')}</details>` : ''}${done.length ? `<details class="past"><summary>완료 ${done.length}건</summary>${done.map(row).join('')}</details>` : ''}<p class="caption">고위험군 접종과 매년 맞는 인플루엔자(생후 6개월부터)는 목록에 넣지 않았어요. 소아과나 예방접종도우미에서 확인해 주세요.</p><button class="plain" data-page="schedule">← 일정으로</button>`;
  }
  H.register({
    id: 'vaccines',
    init() { H.style('vaccines', '.vax-card ul{list-style:none;margin:0 0 6px;padding:0}.vax-card li{padding:5px 0}.vax-card h2{margin:0 0 4px}'); },
    slots: {home: homeCard, schedule: entry},
    pages: {vaccines: {title: '예방접종·검진', view: pageView}},
    reset() { Object.assign(ui, {child: '', status: '', showLater: false}); },
    async click(button) {
      const d = button.dataset || {}, child = baby();
      if (d.vaxChild) { ui.child = d.vaxChild; ui.status = ''; render(); return true; }
      if (!child || !(d.vaxDone || d.vaxUndo || d.vaxPlan || d.vaxAll || d.vaxChoice)) return false;
      if (d.vaxChoice) {
        const [vaccine, value] = d.vaxChoice.split(':');
        if (VACCINES.find(v => v.id === vaccine)?.choice?.[value] && await H.save('vaccines', {id: choiceId(child, vaccine), value})) render();
        return true;
      }
      const find = id => listFor(child).find(x => x.id === id);
      if (d.vaxDone) {
        const x = find(d.vaxDone);
        if (x && await H.save('vaccines', {id: doneId(child, x.id), at: today()})) { ui.status = `${x.name} ${x.label}을(를) 완료로 표시했어요.`; render(); }
        return true;
      }
      if (d.vaxUndo) { if (await H.remove('vaccines', doneId(child, d.vaxUndo))) render(); return true; }
      if (d.vaxAll) {
        const past = listFor(child).filter(x => x.status === 'past');
        if (!confirm(`표준 시기가 지난 ${past.length}건을 모두 ‘했어요’로 표시할까요?\n실제로 맞은 것만 표시해 주세요.`)) return true;
        for (const x of past) if (!await H.save('vaccines', {id: doneId(child, x.id), at: today(), bulk: true})) break;
        ui.status = '완료로 표시했어요.'; render();
        return true;
      }
      const x = find(d.vaxPlan);
      if (x && !planned(x)) {
        const when = (x.start > today() ? x.start : today()) + 'T10:00', who = children().includes(child.name) ? child.name : '가족';
        if (await changeItem('schedule', {id: newId(), date: when, who, title: title(x), place: '', memo: `${x.when} · 시각은 예약에 맞게 고쳐 주세요`})) { ui.status = `일정에 넣었어요 (${when.replace('T', ' ')}). 예약 시각으로 고쳐 주세요.`; render(); }
      }
      return true;
    },
  });
})(typeof window !== 'undefined' ? window : this);
