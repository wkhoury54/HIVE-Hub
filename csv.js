"use strict";
// Minimal CSV writer — no dependency needed for straightforward tabular export.

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// rows: array of objects. columns: array of [header, key] pairs (or plain keys,
// in which case the key itself is used as the header).
function toCsv(rows, columns) {
  const cols = columns.map((c) => (Array.isArray(c) ? c : [c, c]));
  const header = cols.map(([label]) => csvCell(label)).join(",");
  const lines = rows.map((row) => cols.map(([, key]) => csvCell(typeof key === "function" ? key(row) : row[key])).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.end(csv);
}

module.exports = { toCsv, sendCsv };
