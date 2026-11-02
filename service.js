/* Shared display logic; no server or AI calls. */
(function (root) {
  'use strict';
  function localDateTime(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function summary(records, now = new Date()) {
    const date = localDateTime(now).slice(0, 10);
    const today = records.filter(x => x.type === 'feeding' && x.date.slice(0, 10) === date);
    const measured = today.map(x => /^\s*(\d+(?:\.\d+)?)\s*(?:ml|mL|미리|밀리리터)\s*$/i.exec(x.amount)).filter(Boolean);
    const latest = records.filter(x => x.type === 'feeding' && x.date <= localDateTime(now)).sort((a,b) => b.date.localeCompare(a.date))[0];
    return { count: today.length, volume: Math.round(measured.reduce((sum, match) => sum + Number(match[1]), 0)*10)/10, measuredCount: measured.length, latest: latest ? latest.date : null };
  }
  function filter(items, options = {}) {
    const query = (options.query || '').trim().toLocaleLowerCase();
    return items.filter(x => (!query || Object.values(x).some(v => String(v).toLocaleLowerCase().includes(query)))
      && (!options.type || x.type === options.type)
      && (!options.from || (x.date || '').slice(0,10) >= options.from)
      && (!options.to || (x.date || '').slice(0,10) <= options.to)
      && (!options.status || (x.done === 'yes' ? 'done' : 'pending') === options.status));
  }
  const api = { localDateTime, summary, filter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Somhouse = api;
})(typeof window !== 'undefined' ? window : this);
