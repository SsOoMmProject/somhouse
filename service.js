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
  // Totals of feedings between two dates (inclusive, YYYY-MM-DD). Entries after now are not counted.
  function rangeSummary(records, from, to, now = new Date()) {
    const current = localDateTime(now);
    const entries = records.filter(x => x.type === 'feeding' && x.date <= current && x.date.slice(0, 10) >= from && x.date.slice(0, 10) <= to);
    const minutes = entries.map(x => feedingMinutes(x.amount)).filter(v => v !== null);
    return {from, to, count: entries.length, ...measuredVolume(entries),
            minutes: Number(minutes.reduce((a, b) => a + b, 0).toFixed(1)), timedCount: minutes.length};
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
  function monthGrid(records, year, month, now = new Date(), schedule = [], shopping = []) {
    const first = new Date(year, month - 1, 1), days = new Date(year, month, 0).getDate();
    const cells = Array.from({length: first.getDay()}, () => null);
    const onDay = (items, key) => items.filter(x => (x.date || '').slice(0, 10) === key);
    for (let day = 1; day <= days; day++) {
      const key = dayKey(new Date(year, month - 1, day));
      cells.push({date: key, day, future: key > dayKey(now), ...rangeSummary(records, key, key, now),
                  schedule: onDay(schedule, key).length,
                  shopping: onDay(shopping, key).filter(x => x.done !== 'yes').length});
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
  const api = { localDateTime, summary, dailyFeeding, feedingVolume, feedingMinutes, hasFeedingUnit, recentFeedings, rangeSummary, periodSummaries, monthGrid, weekStart, addDays, filter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Somhouse = api;
})(typeof window !== 'undefined' ? window : this);
