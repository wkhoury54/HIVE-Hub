"use strict";

function pad(n) { return String(n).padStart(2, "0"); }
function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

const PRESET_LABELS = {
  mtd: "Month to date",
  ytd: "Year to date",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  lastmonth: "Last month",
  lastyear: "Last year",
  custom: "Custom range",
};

// Computes { start, end, label } (ISO date strings) for a named preset, or
// for "custom" using the supplied from/to. `today` defaults to now.
function computeRange(range, from, to, today) {
  today = today || new Date();
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  switch (range) {
    case "mtd":
      return { start: iso(new Date(t.getFullYear(), t.getMonth(), 1)), end: iso(t), label: PRESET_LABELS.mtd };
    case "7d":
      return { start: iso(addDays(t, -6)), end: iso(t), label: PRESET_LABELS["7d"] };
    case "30d":
      return { start: iso(addDays(t, -29)), end: iso(t), label: PRESET_LABELS["30d"] };
    case "90d":
      return { start: iso(addDays(t, -89)), end: iso(t), label: PRESET_LABELS["90d"] };
    case "lastmonth": {
      const firstThis = new Date(t.getFullYear(), t.getMonth(), 1);
      const lastMonthEnd = addDays(firstThis, -1);
      const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
      return { start: iso(lastMonthStart), end: iso(lastMonthEnd), label: PRESET_LABELS.lastmonth };
    }
    case "lastyear":
      return { start: (t.getFullYear() - 1) + "-01-01", end: (t.getFullYear() - 1) + "-12-31", label: PRESET_LABELS.lastyear };
    case "custom":
      if (from && to) return { start: from, end: to, label: PRESET_LABELS.custom };
      return computeRange("ytd", null, null, today);
    case "ytd":
    default:
      return { start: t.getFullYear() + "-01-01", end: iso(t), label: PRESET_LABELS.ytd };
  }
}

module.exports = { computeRange, PRESET_LABELS, iso };
