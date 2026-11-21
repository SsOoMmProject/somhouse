'use strict';
/* The first thing the next caregiver needs: how last night went and what is likely next.
   Worked out on this device from the family's own records, with no AI, key or network. Each prediction also grades
   itself on the family's past days, using only what it would have known at the time, and shows that hit rate.
   It describes this baby's recent pattern and makes no health judgement. */
(function (root) {
  const WINDOW_DAYS = 14, MAX_GAP = 8 * 60, SAME_FEEDING = 20, MAX_AWAKE = 6 * 60, HALF_LIFE_DAYS = 4, TIME_SPREAD = 90;
  const TEST_LAST = 30, MIN_HISTORY = 6, HIT_MINUTES = 30, MIN_SCORED = 5;
  const pad = n => String(n).padStart(2, '0');
  // Minutes on a plain clock, so a local "YYYY-MM-DDTHH:MM" compares and subtracts exactly.
  function minuteOf(stamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stamp || '');
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
  }
  function stampOf(minute) {
    const d = new Date(minute * 60000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  const hourOf = minute => Math.floor(((minute % 1440) + 1440) % 1440 / 60);
  function quantile(samples, q) {
    const sorted = [...samples].sort((a, b) => a.value - b.value), total = sorted.reduce((s, x) => s + x.weight, 0);
    let seen = 0;
    for (const x of sorted) { seen += x.weight; if (seen >= total * q) return x.value; }
    return sorted[sorted.length - 1].value;
  }
  // The usual length after a moment like this one: the closer in time of day and the more recent, the more it counts.
  function estimate(history, at) {
    if (history.length < 4) return null;
    const samples = history.map(x => {
      const apart = ((x.at - at) % 1440 + 1440) % 1440, clock = Math.min(apart, 1440 - apart);
      return {value: x.length, weight: 0.5 ** ((at - x.at) / 1440 / HALF_LIFE_DAYS) * Math.exp(-0.5 * (clock / TIME_SPREAD) ** 2) + 1e-9};
    });
    return {length: quantile(samples, 0.5), low: quantile(samples, 0.25), high: quantile(samples, 0.75)};
  }
  // How often this method would have been within 30 minutes, knowing only what came before each moment.
  function selfTest(history) {
    let hits = 0, total = 0;
    for (let i = Math.max(MIN_HISTORY, history.length - TEST_LAST); i < history.length; i++) {
      const guess = estimate(history.slice(0, i), history[i].at);
      if (!guess) continue;
      total++;
      if (Math.abs(guess.length - history[i].length) <= HIT_MINUTES) hits++;
    }
    return {hits, total};
  }
  function level(score) {
    if (score.total < MIN_SCORED) return 'new';
    const rate = score.hits / score.total;
    return rate >= 0.7 ? 'high' : rate >= 0.5 ? 'mid' : 'low';
  }
  function forecast(history, from, now) {
    const guess = estimate(history, from);
    if (!guess) return null;
    const score = selfTest(history), at = from + guess.length;
    // A usable range: not falsely exact, and not so wide that it says nothing.
    const before = Math.min(45, Math.max(10, guess.length - guess.low)), after = Math.min(45, Math.max(10, guess.high - guess.length));
    return {at: stampOf(at), from: stampOf(at - before), to: stampOf(at + after), length: guess.length, late: now > at + after,
            hits: score.hits, total: score.total, level: level(score)};
  }
  // Feedings a few minutes apart are one feeding (a top-up or the other side); the time counts from its end.
  function feedingTimes(records, now) {
    const since = now - WINDOW_DAYS * 1440, times = records.filter(x => x.type === 'feeding').map(x => minuteOf(x.date))
      .filter(x => x !== null && x <= now && x >= since).sort((a, b) => a - b), merged = [];
    for (const t of times) { if (merged.length && t - merged[merged.length - 1] <= SAME_FEEDING) merged[merged.length - 1] = t; else merged.push(t); }
    return merged;
  }
  function nextFeeding(records, nowStamp) {
    const now = minuteOf(nowStamp), times = feedingTimes(records, now), history = [];
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= MAX_GAP) history.push({at: times[i - 1], length: times[i] - times[i - 1]});
    if (!times.length) return null;
    const last = times[times.length - 1];
    if (now - last > MAX_GAP) return null;  // Records stopped; a prediction would be noise.
    return forecast(history, last, now);
  }
  const daytime = minute => hourOf(minute) >= 6 && hourOf(minute) < 20;
  function finishedSleeps(records, now) {
    const since = now - WINDOW_DAYS * 1440;
    return records.filter(x => x.type === 'sleep' && x.end).map(x => ({start: minuteOf(x.date), end: minuteOf(x.end)}))
      .filter(x => x.start !== null && x.end !== null && x.end > x.start && x.end <= now && x.start >= since).sort((a, b) => a.start - b.start);
  }
  function nextNap(records, nowStamp) {
    const now = minuteOf(nowStamp);
    if (records.some(x => x.type === 'sleep' && !x.end && x.date && minuteOf(x.date) <= now && now - minuteOf(x.date) <= 16 * 60)) return null;
    const sleeps = finishedSleeps(records, now);
    if (!sleeps.length) return null;
    const last = sleeps[sleeps.length - 1];
    if (!daytime(last.end) || !daytime(now) || now - last.end > MAX_AWAKE) return null;
    const history = [];
    for (let i = 1; i < sleeps.length; i++) {
      const awake = sleeps[i].start - sleeps[i - 1].end;
      if (awake > 0 && awake <= MAX_AWAKE && daytime(sleeps[i - 1].end)) history.push({at: sleeps[i - 1].end, length: awake});
    }
    return forecast(history, last.end, now);
  }
  // Last night: 19:00 yesterday until 07:00 today, or until now when it is still early.
  function lastNight(records, nowStamp) {
    const now = minuteOf(nowStamp), midnight = Math.floor(now / 1440) * 1440, hour = hourOf(now);
    const day = hour < 19 ? midnight : midnight + 1440;
    const start = day - 5 * 60, end = Math.min(day + 7 * 60, now);
    if (hour >= 19) return null;  // The evening belongs to tonight; last night's story has been told.
    const inside = t => t !== null && t >= start && t < end;
    const feeds = records.filter(x => x.type === 'feeding' && inside(minuteOf(x.date)));
    const ml = feeds.map(x => Somhouse.feedingVolume(x.amount)).filter(v => v !== null);
    const diapers = records.filter(x => x.type === 'diaper' && inside(minuteOf(x.date))).length;
    const parts = records.filter(x => x.type === 'sleep' && x.date).map(x => {
      const from = minuteOf(x.date), to = x.end ? minuteOf(x.end) : (now - from <= 16 * 60 ? now : null);
      return from === null || to === null || to <= from ? null : {from: Math.max(from, start), to: Math.min(to, end)};
    }).filter(x => x && x.to > x.from).sort((a, b) => a.from - b.from);
    if (!feeds.length && !diapers && !parts.length) return null;
    const merged = [];
    for (const x of parts) { const prev = merged[merged.length - 1]; if (prev && x.from <= prev.to) prev.to = Math.max(prev.to, x.to); else merged.push({...x}); }
    return {from: stampOf(start), to: stampOf(end), feeds: feeds.length, ml: ml.length ? Math.round(ml.reduce((a, b) => a + b, 0)) : null, mlCount: ml.length,
            diapers, sleepMinutes: merged.reduce((s, x) => s + x.to - x.from, 0), longest: merged.reduce((m, x) => Math.max(m, x.to - x.from), 0),
            wakes: Math.max(0, merged.length - 1)};
  }
  const api = {nextFeeding, nextNap, lastNight, minuteOf, stampOf};
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.SomhouseBriefing = api;

  const H = SomhouseFeatures;
  const SURE = {high: '잘 맞는 편', mid: '보통', low: '패턴이 아직 불규칙해요', new: '맞는지 확인하는 중'};
  const hm = stamp => stamp.slice(11);
  function predictionLine(icon, name, x) {
    const range = `${hm(x.from)}~${hm(x.to)}`, score = x.total >= 5 ? `최근 ${x.total}번 중 ${x.hits}번 ±30분 안에 맞음` : '기록이 더 쌓이면 정확도를 알려 드려요';
    return `<li><b>${icon} 다음 ${name}</b> ${x.late ? `${esc(range)} 예상이었어요 (지났어요)` : `${esc(range)} 무렵`} <span class="badge">${esc(SURE[x.level])}</span><br><span class="caption">보통 ${esc(Somhouse.duration(Math.round(x.length)))} 간격 · ${esc(score)}</span></li>`;
  }
  function card() {
    if (!data.records.length) return '';
    const now = Somhouse.localDateTime(), night = lastNight(data.records, now), feed = nextFeeding(data.records, now), nap = nextNap(data.records, now), rows = [];
    if (night) {
      const parts = [`수유 ${night.feeds}번${night.ml !== null ? ` · ${night.ml.toLocaleString('ko-KR')}ml` : ''}`];
      if (night.sleepMinutes) parts.push(`잠 ${Somhouse.duration(night.sleepMinutes)} (가장 길게 ${Somhouse.duration(night.longest)}${night.wakes ? ` · ${night.wakes}번 깸` : ''})`);
      if (night.diapers) parts.push(`기저귀 ${night.diapers}번`);
      rows.push(`<li><b>🌙 지난밤</b> <span class="caption">${esc(hm(night.from))}~${esc(hm(night.to))}</span><br>${parts.map(esc).join(' · ')}</li>`);
    }
    if (feed) rows.push(predictionLine('🍼', '수유', feed));
    if (nap) rows.push(predictionLine('😴', '잠', nap));
    if (!rows.length) return '';
    return `<section class="card briefing" aria-label="오늘의 브리핑"><h2>🌅 오늘의 브리핑</h2><ul>${rows.join('')}</ul><p class="caption">이 기기에서 우리 가족 기록으로만 계산한 참고용 패턴이에요. 건강 상태를 판단하지 않아요.</p></section>`;
  }
  H.register({
    id: 'briefing',
    init() { H.style('briefing', '.briefing ul{list-style:none;margin:0 0 6px;padding:0}.briefing li{padding:8px 0;border-top:1px solid #eeeee7}.briefing li:first-child{border-top:0}.briefing h2{margin:0 0 4px}'); },
    slots: {home: card},
  });
})(typeof window !== 'undefined' ? window : this);
