/* Shared display logic; no server or AI calls. */
(function (root) {
  'use strict';
  function localDateTime(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function feedingVolume(amount) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(?:ml|밀리\s*리터|미리|cc|씨씨)\s*$/i.exec(amount);
    const value = match ? Number(match[1]) : NaN;
    return Number.isFinite(value) ? value : null;
  }
  function measuredVolume(records) {
    const measured = records.map(x => feedingVolume(x.amount)).filter(value => value !== null);
    const total = measured.reduce((sum, value) => sum + value, 0);
    return {volume: Number(total.toFixed(1)), measuredCount: measured.length};
  }
  function summary(records, now = new Date()) {
    const date = localDateTime(now).slice(0, 10);
    const today = records.filter(x => x.type === 'feeding' && x.date.slice(0, 10) === date);
    const latest = records.filter(x => x.type === 'feeding' && x.date <= localDateTime(now)).sort((a,b) => b.date.localeCompare(a.date))[0];
    return {count: today.length, ...measuredVolume(today), latest: latest ? latest.date : null};
  }
  function dailyFeeding(records, days, now = new Date()) {
    const byDate = new Map();
    for (const item of records) {
      if (item.type !== 'feeding') continue;
      const date = item.date.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(item);
    }
    return Array.from({length: days}, (_, index) => {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1 + index);
      const date = localDateTime(day).slice(0, 10);
      const entries = byDate.get(date) || [];
      return {date, count: entries.length, ...measuredVolume(entries)};
    });
  }
  // A preset is only useful when its amount is unambiguous: a volume (ml, cc, ...) or a duration (분, 시간).
  function hasFeedingUnit(amount) {
    return feedingVolume(amount) !== null || /^\s*\d+(?:\.\d+)?\s*(?:분|시간)\s*$/.test(amount);
  }
  // Distinct recent feeding presets (category + amount), newest first. Future and unit-less entries are ignored.
  function recentFeedings(records, limit = 3, now = new Date()) {
    const current = localDateTime(now), seen = new Set(), result = [];
    const feedings = records.filter(x => x.type === 'feeding' && x.date <= current && x.category && x.amount && hasFeedingUnit(x.amount))
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const x of feedings) {
      const amount = x.amount.trim(), key = x.category + '\u0000' + amount;
      if (!amount || seen.has(key)) continue;
      seen.add(key);
      result.push({category: x.category, amount});
      if (result.length >= limit) break;
    }
    return result;
  }
  // Direct breastfeeding is recorded as minutes ("15분"); it is summed separately from volume.
  function feedingMinutes(amount) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*분\s*$/.exec(amount || '');
    return match ? Number(match[1]) : null;
  }
  // Minutes between a sleep's start and end (local "YYYY-MM-DDTHH:MM"), or null when it has no end yet.
  function sleepMinutes(x) {
    if (!x.end || x.end <= x.date) return null;
    const at = v => { const [d, t] = v.split('T'); const [y, m, day] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, m - 1, day, h, mi); };
    return Math.round((at(x.end) - at(x.date)) / 60000);
  }
  function duration(minutes) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `${h}시간${m ? ` ${m}분` : ''}` : `${m}분`;
  }
  function dayKey(date) { return localDateTime(date).slice(0, 10); }
  function addDays(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d + days));
  }
  // Weeks start on Sunday, like the phone's calendar.
  function weekStart(key) {
    const [y, m, d] = key.split('-').map(Number);
    return addDays(key, -new Date(y, m - 1, d).getDay());
  }
  // Minutes of a finished sleep that fall between two local stamps; null for a sleep without a wake time.
  function overlapMinutes(x, start, end) {
    if (sleepMinutes(x) === null) return null;
    const from = x.date > start ? x.date : start, to = x.end < end ? x.end : end;
    return to > from ? sleepMinutes({date: from, end: to}) : 0;
  }
  // Totals between two dates (inclusive, YYYY-MM-DD). Entries after now are not counted.
  // A sleep that crosses midnight counts on each day it touches, with only the minutes of that day.
  function rangeSummary(records, from, to, now = new Date()) {
    const current = localDateTime(now), start = from + 'T00:00', end = addDays(to, 1) + 'T00:00';
    const inRange = x => x.date <= current && x.date.slice(0, 10) >= from && x.date.slice(0, 10) <= to;
    const entries = records.filter(x => x.type === 'feeding' && inRange(x));
    const minutes = entries.map(x => feedingMinutes(x.amount)).filter(v => v !== null);
    const sleeps = records.filter(x => x.type === 'sleep' && x.date <= current && x.date < end
      && (sleepMinutes(x) !== null ? x.end > start : x.date >= start));
    const slept = sleeps.map(x => overlapMinutes(x, start, end)).filter(v => v !== null);
    const diapers = records.filter(x => x.type === 'diaper' && inRange(x));
    return {from, to, count: entries.length, ...measuredVolume(entries),
            minutes: Number(minutes.reduce((a, b) => a + b, 0).toFixed(1)), timedCount: minutes.length,
            sleepCount: sleeps.length, sleepMinutes: slept.reduce((a, b) => a + b, 0), sleepTimed: slept.length,
            diaperCount: diapers.length, peeCount: diapers.filter(x => x.category !== '대변').length,
            pooCount: diapers.filter(x => x.category !== '소변').length};
  }
  // One day of sleep: minutes asleep that day (a sleep crossing midnight counts on each day it touches), split
  // into naps and night sleep by the sleep's kind; naps started that day; the longest finished sleep started that day.
  function sleepDay(records, day, now = new Date()) {
    const current = localDateTime(now), start = day + 'T00:00', end = addDays(day, 1) + 'T00:00';
    let nap = 0, night = 0, naps = 0, longest = 0, recorded = false;
    for (const x of records) {
      if (x.type !== 'sleep' || !x.date || x.date > current) continue;
      const minutes = overlapMinutes(x, start, end);
      if (minutes) { recorded = true; if (x.category === '낮잠') nap += minutes; else night += minutes; }
      if (x.date >= start && x.date < end) {
        recorded = true;
        if (x.category === '낮잠') naps++;
        const full = sleepMinutes(x);
        if (full !== null && full <= 24 * 60) longest = Math.max(longest, full);
      }
    }
    return {day, recorded, total: nap + night, nap, night, naps, longest};
  }
  // Diapers changed that day; 둘 다 counts as both.
  function diaperDay(records, day, now = new Date()) {
    const current = localDateTime(now), list = records.filter(x => x.type === 'diaper' && x.date && x.date.slice(0, 10) === day && x.date <= current);
    return {day, count: list.length, pee: list.filter(x => x.category !== '대변').length, poo: list.filter(x => x.category !== '소변').length};
  }
  // The latest diaper with poo, or null.
  function lastPoo(records, now = new Date()) {
    const current = localDateTime(now);
    return records.filter(x => x.type === 'diaper' && x.category !== '소변' && x.date && x.date <= current)
      .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  }
  // One day of the 24-hour pattern: sleeps as bars, feedings and diapers as points, in minutes from 00:00.
  // A sleep that is still open runs until now (at most 16 hours, like the server's open-sleep rule).
  function daySegments(records, day, now = new Date()) {
    const current = localDateTime(now), start = day + 'T00:00', end = addDays(day, 1) + 'T00:00';
    const minute = v => sleepMinutes({date: start, end: v}) ?? 0;
    const sleeps = [];
    for (const x of records) {
      if (x.type !== 'sleep' || !x.date || x.date > current) continue;
      let until = sleepMinutes(x) !== null ? x.end : null, open = false;
      if (until === null) {
        const running = sleepMinutes({date: x.date, end: current});
        if (running === null || running > 16 * 60) continue;
        until = current; open = true;
      }
      if (x.date >= end || until <= start) continue;
      sleeps.push({id: x.id, category: x.category, open, from: x.date > start ? minute(x.date) : 0,
                   to: until < end ? minute(until) : 24 * 60});
    }
    const points = type => records.filter(x => x.type === type && x.date >= start && x.date < end && x.date <= current)
      .map(x => ({id: x.id, at: minute(x.date), category: x.category, amount: x.amount || ''}));
    return {day, sleeps: sleeps.sort((a, b) => a.from - b.from), feedings: points('feeding'), diapers: points('diaper')};
  }
  // When the next feeding is likely: the last feeding plus the average gap of the last 7 days (gaps of 8 hours
  // or less, at least 3 of them). Null when there is not enough history.
  function nextFeeding(records, now = new Date()) {
    const current = localDateTime(now), since = addDays(current.slice(0, 10), -7);
    const feeds = records.filter(x => x.type === 'feeding' && x.date <= current && x.date.slice(0, 10) >= since)
      .sort((a, b) => a.date.localeCompare(b.date));
    const gaps = feeds.slice(1).map((x, i) => sleepMinutes({date: feeds[i].date, end: x.date})).filter(m => m !== null && m > 0 && m <= 8 * 60);
    if (gaps.length < 3) return null;
    const gap = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), last = feeds[feeds.length - 1].date;
    const [d, t] = last.split('T'), [y, m, dd] = d.split('-').map(Number), [h, mi] = t.split(':').map(Number);
    return {at: localDateTime(new Date(y, m - 1, dd, h, mi + gap)), gap, after: last};
  }
  function periodSummaries(records, now = new Date()) {
    const today = dayKey(now), yesterday = addDays(today, -1), week = weekStart(today);
    return [
      {key: 'today', label: '오늘', ...rangeSummary(records, today, today, now)},
      {key: 'yesterday', label: '어제', ...rangeSummary(records, yesterday, yesterday, now)},
      {key: 'week', label: '이번 주', ...rangeSummary(records, week, today, now)},
      {key: 'lastWeek', label: '지난주', ...rangeSummary(records, addDays(week, -7), addDays(week, -1), now)},
    ];
  }
  // A month grid (Sunday first) with each day's feeding totals and its schedule and dated shopping items;
  // days outside the month are null.
  function monthGrid(records, year, month, now = new Date(), schedule = [], shopping = [], google = []) {
    const first = new Date(year, month - 1, 1), days = new Date(year, month, 0).getDate();
    const cells = Array.from({length: first.getDay()}, () => null);
    const onDay = (items, key) => items.filter(x => (x.date || '').slice(0, 10) === key);
    for (let day = 1; day <= days; day++) {
      const key = dayKey(new Date(year, month - 1, day));
      cells.push({date: key, day, future: key > dayKey(now), ...rangeSummary(records, key, key, now),
                  schedule: onDay(schedule, key).length,
                  shopping: onDay(shopping, key).filter(x => x.done !== 'yes').length,
                  google: google.filter(x => (x.date || '').slice(0, 10) <= key && (x.end || x.date || '').slice(0, 10) >= key).length});
    }
    while (cells.length % 7) cells.push(null);
    return cells;
  }
  function filter(items, options = {}) {
    const query = (options.query || '').trim().toLocaleLowerCase();
    return items.filter(x => (!query || Object.values(x).some(v => String(v).toLocaleLowerCase().includes(query)))
      && (!options.type || x.type === options.type)
      && (!options.from || (x.date || '').slice(0,10) >= options.from)
      && (!options.to || (x.date || '').slice(0,10) <= options.to)
      && (!options.status || (x.done === 'yes' ? 'done' : 'pending') === options.status));
  }
  const api = { localDateTime, summary, dailyFeeding, sleepDay, diaperDay, lastPoo, feedingVolume, feedingMinutes, sleepMinutes, duration, hasFeedingUnit, recentFeedings, rangeSummary, daySegments, nextFeeding, periodSummaries, monthGrid, weekStart, addDays, filter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Somhouse = api;
})(typeof window !== 'undefined' ? window : this);
