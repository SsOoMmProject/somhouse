'use strict';
/* Weight, length and head size over time, against the WHO Child Growth Standards (birth to 24 months), the reference
   Korea's national growth chart uses under 3 years. It shows where a measurement sits and how the line moves, as a
   reference for talking with the pediatrician. It never labels a child as normal or abnormal.
   Table: WHO L, M and S values by month, as published in the CDC's WHO growth chart data files. */
(function (root) {
  const LMS = {"weight":{"남":[[0.3487,3.3464,0.14602],[0.2297,4.4709,0.13395],[0.197,5.5675,0.12385],[0.1738,6.3762,0.11727],[0.1553,7.0023,0.11316],[0.1395,7.5105,0.1108],[0.1257,7.934,0.10958],[0.1134,8.297,0.10902],[0.1021,8.6151,0.10882],[0.0917,8.9014,0.10881],[0.082,9.1649,0.10891],[0.073,9.4122,0.10906],[0.0644,9.6479,0.10925],[0.0563,9.8749,0.10949],[0.0487,10.0953,0.10976],[0.0413,10.3108,0.11007],[0.0343,10.5228,0.11041],[0.0275,10.7319,0.11079],[0.0211,10.9385,0.11119],[0.0148,11.143,0.11164],[0.0087,11.3462,0.11211],[0.0029,11.5486,0.11261],[-0.0028,11.7504,0.11314],[-0.0083,11.9514,0.11369],[-0.0137,12.1515,0.11426]],"여":[[0.3809,3.2322,0.14171],[0.1714,4.1873,0.13724],[0.0962,5.1282,0.13],[0.0402,5.8458,0.12619],[-0.005,6.4237,0.12402],[-0.043,6.8985,0.12274],[-0.0756,7.297,0.12204],[-0.1039,7.6422,0.12178],[-0.1288,7.9487,0.12181],[-0.1507,8.2254,0.12199],[-0.17,8.48,0.12223],[-0.1872,8.7192,0.12247],[-0.2024,8.9481,0.12268],[-0.2158,9.1699,0.12283],[-0.2278,9.387,0.12294],[-0.2384,9.6008,0.12299],[-0.2478,9.8124,0.12303],[-0.2562,10.0226,0.12306],[-0.2637,10.2315,0.12309],[-0.2703,10.4393,0.12315],[-0.2762,10.6464,0.12323],[-0.2815,10.8534,0.12335],[-0.2862,11.0608,0.1235],[-0.2903,11.2688,0.12369],[-0.2941,11.4775,0.1239]]},"length":{"남":[[1,49.8842,0.03795],[1,54.7244,0.03557],[1,58.4249,0.03424],[1,61.4292,0.03328],[1,63.886,0.03257],[1,65.9026,0.03204],[1,67.6236,0.03165],[1,69.1645,0.03139],[1,70.5994,0.03124],[1,71.9687,0.03117],[1,73.2812,0.03118],[1,74.5388,0.03125],[1,75.7488,0.03137],[1,76.9186,0.03154],[1,78.0497,0.03174],[1,79.1458,0.03197],[1,80.2113,0.03222],[1,81.2487,0.0325],[1,82.2587,0.03279],[1,83.2418,0.0331],[1,84.1996,0.03342],[1,85.1348,0.03376],[1,86.0477,0.0341],[1,86.941,0.03445],[1,87.8161,0.03479]],"여":[[1,49.1477,0.0379],[1,53.6872,0.0364],[1,57.0673,0.03568],[1,59.8029,0.0352],[1,62.0899,0.03486],[1,64.0301,0.03463],[1,65.7311,0.03448],[1,67.2873,0.03441],[1,68.7498,0.0344],[1,70.1435,0.03444],[1,71.4818,0.03452],[1,72.771,0.03464],[1,74.015,0.03479],[1,75.2176,0.03496],[1,76.3817,0.03514],[1,77.5099,0.03534],[1,78.6055,0.03555],[1,79.671,0.03576],[1,80.7079,0.03598],[1,81.7182,0.0362],[1,82.7036,0.03643],[1,83.6654,0.03666],[1,84.604,0.03688],[1,85.5202,0.03711],[1,86.4153,0.03734]]},"head":{"남":[[1,34.4618,0.03686],[1,37.2759,0.03133],[1,39.1285,0.02997],[1,40.5135,0.02918],[1,41.6317,0.02868],[1,42.5576,0.02837],[1,43.3306,0.02817],[1,43.9803,0.02804],[1,44.53,0.02796],[1,44.9998,0.02792],[1,45.4051,0.0279],[1,45.7573,0.02789],[1,46.0661,0.02789],[1,46.3395,0.02789],[1,46.5844,0.02791],[1,46.806,0.02792],[1,47.0088,0.02795],[1,47.1962,0.02797],[1,47.3711,0.028],[1,47.5357,0.02803],[1,47.6919,0.02806],[1,47.8408,0.0281],[1,47.9833,0.02813],[1,48.1201,0.02817],[1,48.2515,0.02821]],"여":[[1,33.8787,0.03496],[1,36.5463,0.0321],[1,38.2521,0.03168],[1,39.5328,0.0314],[1,40.5817,0.03119],[1,41.459,0.03102],[1,42.1995,0.03087],[1,42.829,0.03075],[1,43.3671,0.03063],[1,43.83,0.03053],[1,44.2319,0.03044],[1,44.5844,0.03035],[1,44.8965,0.03027],[1,45.1752,0.03019],[1,45.4265,0.03012],[1,45.6551,0.03006],[1,45.865,0.02999],[1,46.0598,0.02993],[1,46.2424,0.02987],[1,46.4152,0.02982],[1,46.5801,0.02977],[1,46.7384,0.02972],[1,46.8913,0.02967],[1,47.0391,0.02962],[1,47.1822,0.02957]]}};
  const INDICATORS = {weight: {label: '몸무게', unit: 'kg', min: 0.5, max: 30, step: '0.01'}, length: {label: '키', unit: 'cm', min: 25, max: 130, step: '0.1'}, head: {label: '머리둘레', unit: 'cm', min: 20, max: 65, step: '0.1'}};
  const MONTH_DAYS = 30.4375, MAX_MONTH = 24;
  // L, M and S at an age in months, straight-line between the published months.
  function lmsAt(key, sex, months) {
    const table = LMS[key]?.[sex];
    if (!table || !(months >= 0) || months > MAX_MONTH) return null;
    const low = Math.floor(months), high = Math.min(MAX_MONTH, low + 1), part = months - low;
    return table[low].map((v, i) => v + (table[high][i] - v) * part);
  }
  function zScore(value, [L, M, S]) { return Math.abs(L) < 1e-9 ? Math.log(value / M) / S : ((value / M) ** L - 1) / (L * S); }
  // Normal distribution, Abramowitz & Stegun 26.2.17.
  function normal(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - tail : tail;
  }
  function percentileOf(key, sex, months, value) {
    const row = lmsAt(key, sex, months);
    return row && value > 0 ? normal(zScore(value, row)) * 100 : null;
  }
  // Inverse of the normal distribution, for drawing curves (Acklam's rational approximation).
  function zFromPercentile(percent) {
    const p = percent / 100, a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239], b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572], c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const edge = (q, sign) => sign * (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    if (p < 0.02425) return edge(Math.sqrt(-2 * Math.log(p)), 1);
    if (p > 1 - 0.02425) return edge(Math.sqrt(-2 * Math.log(1 - p)), -1);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function valueAt(key, sex, months, z) {
    const row = lmsAt(key, sex, months);
    if (!row) return null;
    const [L, M, S] = row;
    return Math.abs(L) < 1e-9 ? M * Math.exp(S * z) : M * (1 + L * S * z) ** (1 / L);
  }
  const monthsOld = days => days / MONTH_DAYS;
  const percentText = p => (p === null ? '' : p < 1 ? '1 미만' : p > 99 ? '99 초과' : String(Math.round(p)));
  function checkEntry({date, weight, length, head}, birth, today) {
    const realDay = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
    if (!realDay || date > today) return '측정한 날을 확인해 주세요.';
    if (birth && date < birth) return '태어난 날 이전으로는 기록할 수 없어요.';
    const values = {weight, length, head}, filled = Object.entries(values).filter(([, v]) => String(v ?? '').trim() !== '');
    if (!filled.length) return '몸무게·키·머리둘레 중 하나는 적어 주세요.';
    for (const [key, v] of filled) {
      const info = INDICATORS[key], n = Number(v);
      if (!Number.isFinite(n) || n < info.min || n > info.max) return `${info.label}은(는) ${info.min}~${info.max}${info.unit}로 적어 주세요.`;
    }
    return '';
  }
  const api = {LMS, INDICATORS, lmsAt, zScore, percentileOf, zFromPercentile, valueAt, monthsOld, percentText, checkEntry};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  const H = SomhouseFeatures, ui = {show: 'weight', status: '', child: ''};
  const consented = () => !root.SomhouseConsent || root.SomhouseConsent.has('health');
  const baby = () => { const list = H.profiles(); return list.find(x => x.id === ui.child) || list[0] || null; };
  const entriesFor = child => H.items('growth').filter(x => x && (x.child === child?.id)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const ageMonths = (child, day) => { const age = H.ageOn(child.birth, day); return age ? monthsOld(age.days) : null; };
  const ageLabel = (child, day) => { const age = H.ageOn(child.birth, day); return age ? (age.months < 1 ? `${age.days}일` : `${age.months}개월`) : ''; };
  function chart(child, key) {
    const info = INDICATORS[key], list = entriesFor(child).filter(x => x[key] !== undefined && x[key] !== '').map(x => ({m: ageMonths(child, x.date), v: Number(x[key])})).filter(x => x.m !== null && x.m <= MAX_MONTH);
    const last = list.length ? Math.max(...list.map(x => x.m)) : 0, span = Math.min(MAX_MONTH, Math.max(6, Math.ceil(last / 6) * 6));
    const curves = [[3, '#c9d3cb'], [50, '#7d9583'], [97, '#c9d3cb']].map(([p, color]) => ({p, color, points: Array.from({length: span * 2 + 1}, (_, i) => [i / 2, valueAt(key, child.sex, i / 2, zFromPercentile(p))])}));
    const all = [...curves.flatMap(c => c.points.map(x => x[1])), ...list.map(x => x.v)], low = Math.min(...all), high = Math.max(...all), W = 340, H_ = 200, pad = {l: 34, r: 28, t: 8, b: 22};
    const X = m => pad.l + (m / span) * (W - pad.l - pad.r), Y = v => H_ - pad.b - ((v - low) / (high - low || 1)) * (H_ - pad.t - pad.b);
    const lines = curves.map(c => `<polyline fill="none" stroke="${c.color}" stroke-width="1.5" points="${c.points.map(([m, v]) => `${X(m).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/><text x="${W - pad.r + 3}" y="${(Y(c.points.at(-1)[1]) + 3).toFixed(1)}" font-size="10" fill="#6d7971">${c.p}</text>`).join('');
    const ticks = Array.from({length: span / 3 + 1}, (_, i) => i * 3).map(m => `<text x="${X(m).toFixed(1)}" y="${H_ - 6}" font-size="10" text-anchor="middle" fill="#6d7971">${m}</text>`).join('');
    const scale = [low, (low + high) / 2, high].map(v => `<text x="2" y="${(Y(v) + 3).toFixed(1)}" font-size="10" fill="#6d7971">${v.toFixed(key === 'weight' ? 1 : 0)}</text>`).join('');
    const own = list.length > 1 ? `<polyline fill="none" stroke="#815442" stroke-width="2" points="${list.map(x => `${X(x.m).toFixed(1)},${Y(x.v).toFixed(1)}`).join(' ')}"/>` : '';
    const dots = list.map(x => `<circle cx="${X(x.m).toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="3.5" fill="#815442"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H_}" width="100%" role="img" aria-label="${esc(info.label)} 성장 곡선, 기록 ${list.length}개">${lines}${ticks}${scale}${own}${dots}</svg><p class="caption">가로: 개월 · 세로: ${esc(info.unit)} · 연한 선은 WHO 기준 3·50·97백분위, 갈색이 우리 아기예요.</p>`;
  }
  const stat = (child, x, key) => {
    if (x[key] === undefined || x[key] === '') return '';
    const m = ageMonths(child, x.date), p = child.sex && m !== null ? percentileOf(key, child.sex, m, Number(x[key])) : null, info = INDICATORS[key];
    return `<span>${esc(info.label)} <b>${esc(x[key])}${esc(info.unit)}</b>${p !== null ? ` <small>백분위 ${esc(percentText(p))}</small>` : ''}</span>`;
  };
  function statsCard() {
    if (shared?.readOnly || !consented()) return '';
    const child = baby(), last = child ? entriesFor(child).at(-1) : null;
    if (!last) return '<div class="actions report-link"><button type="button" class="secondary" data-page="growth">📈 성장 기록</button></div>';
    return `<section class="card growth-card"><h2>📈 성장 기록</h2><p>${Object.keys(INDICATORS).map(k => stat(child, last, k)).filter(Boolean).join(' · ')}</p><p class="caption">${esc(last.date)} · ${esc(ageLabel(child, last.date))}</p><div class="actions"><button type="button" class="secondary small" data-page="growth">기록하기·곡선 보기</button></div></section>`;
  }
  function pageView() {
    if (!consented()) return '<h1>성장 기록</h1><div class="card empty">이 기능을 쓰려면 먼저 건강 관련 기록 처리에 동의해 주세요.</div><button class="plain" data-page="stats">← 통계로</button>';
    const child = baby(), today = Somhouse.localDateTime().slice(0, 10), profile = H.profileCard('개월 수와 성장표준 비교에 필요해요.', true);
    if (!child) return `<h1>성장 기록</h1>${profile}<button class="plain" data-page="stats">← 통계로</button>`;
    const list = entriesFor(child), tabs = Object.entries(INDICATORS).map(([k, x]) => `<button type="button" class="${ui.show === k ? '' : 'secondary '}small" data-growth-show="${k}" aria-pressed="${ui.show === k}">${x.label}</button>`).join('');
    const age = H.ageOn(child.birth, today), beyond = age && age.months > MAX_MONTH, noSex = !child.sex;
    const pick = H.profiles().length > 1 ? `<div class="quick">${H.profiles().map(x => `<button type="button" class="${x.id === child.id ? '' : 'secondary '}small" data-growth-child="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>` : '';
    const graph = noSex ? '<p class="caption">아기 정보에 성별을 넣으면 WHO 성장표준과 비교한 곡선을 볼 수 있어요.</p>' : beyond ? '<p class="caption">성장표준 비교는 24개월까지만 제공해요. 24개월 이후는 질병관리청 성장도표를 확인해 주세요.</p>' : chart(child, ui.show);
    const form = shared.readOnly ? '' : `<section class="card feature-form" aria-label="성장 기록 입력"><h2>새 측정</h2><label class="field">측정한 날<input id="growth-date" type="date" value="${esc(today)}" max="${esc(today)}"></label>${Object.entries(INDICATORS).map(([k, x]) => `<label class="field">${x.label} (${x.unit}, 선택)<input id="growth-${k}" type="number" inputmode="decimal" step="${x.step}" min="${x.min}" max="${x.max}"></label>`).join('')}<div class="actions"><button type="button" data-growth-save="1">기록</button></div>${ui.status ? `<p class="caption" role="status">${esc(ui.status)}</p>` : ''}</section>`;
    const rows = [...list].reverse().map(x => `<div class="item"><strong>${esc(x.date)} · ${esc(ageLabel(child, x.date))}</strong><p class="growth-values">${Object.keys(INDICATORS).map(k => stat(child, x, k)).filter(Boolean).join(' · ')}</p><button type="button" class="plain small" data-growth-remove="${esc(x.id)}">지우기</button></div>`).join('');
    return `<h1>성장 기록</h1>${profile}${pick}<section class="card"><div class="quick">${tabs}</div>${graph}${noSex || beyond ? '' : '<p class="caption">WHO 성장표준(0~24개월) 기준 참고값이에요. 백분위 40은 같은 개월 수 아기 100명 중 40번째쯤이라는 뜻이고, 한 번의 값보다 곡선의 흐름이 중요해요. 궁금한 점은 소아과에서 확인해 주세요. 이른둥이는 교정 연령으로 봐야 해요.</p>'}</section>${form}<h2 class="section-head">기록</h2>${rows || '<div class="card empty">아직 기록이 없어요.</div>'}<button class="plain" data-page="stats">← 통계로</button>`;
  }
  async function save() {
    const child = baby(), today = Somhouse.localDateTime().slice(0, 10), get = id => String(document.querySelector('#' + id)?.value || '').trim();
    if (!child) return;
    const entry = {date: get('growth-date'), weight: get('growth-weight'), length: get('growth-length'), head: get('growth-head')}, problem = checkEntry(entry, child.birth, today);
    if (problem) { ui.status = problem; render(); return; }
    const item = {id: newId(), child: child.id, date: entry.date};
    for (const k of Object.keys(INDICATORS)) if (entry[k]) item[k] = String(Number(entry[k]));
    if (await H.save('growth', item)) { ui.status = '기록했어요.'; render(); }
  }
  H.register({
    id: 'growth',
    init() { H.style('growth', '.growth-card p{margin:0 0 4px}.growth-values small,.growth-card small{color:#6d7971}'); },
    slots: {stats: statsCard},
    pages: {growth: {title: '성장 기록', view: pageView}},
    reset() { Object.assign(ui, {show: 'weight', status: '', child: ''}); },
    async click(button) {
      const d = button.dataset || {};
      if (d.growthShow && INDICATORS[d.growthShow]) { ui.show = d.growthShow; render(); return true; }
      if (d.growthChild) { ui.child = d.growthChild; render(); return true; }
      if (d.growthSave) { await save(); return true; }
      if (d.growthRemove) {
        if (confirm('이 측정 기록을 지울까요?') && await H.remove('growth', d.growthRemove)) render();
        return true;
      }
      return false;
    },
  });
})(typeof window !== 'undefined' ? window : this);
