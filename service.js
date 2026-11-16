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
  function filter(items, options = {}) {
    const query = (options.query || '').trim().toLocaleLowerCase();
    return items.filter(x => (!query || Object.values(x).some(v => String(v).toLocaleLowerCase().includes(query)))
      && (!options.type || x.type === options.type)
      && (!options.from || (x.date || '').slice(0,10) >= options.from)
      && (!options.to || (x.date || '').slice(0,10) <= options.to)
      && (!options.status || (x.done === 'yes' ? 'done' : 'pending') === options.status));
  }
  const api = { localDateTime, summary, dailyFeeding, feedingVolume, hasFeedingUnit, recentFeedings, filter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Somhouse = api;
})(typeof window !== 'undefined' ? window : this);
