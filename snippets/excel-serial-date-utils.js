/**
 * Excel Serial Date Utilities
 * ===========================
 *
 * Excel stores dates as serial numbers — days elapsed since the
 * Excel epoch. Day 1 is "1900-01-01" in Excel's calendar; an Excel
 * date of `45234` is some time in 2023; `45234.5` is the same day
 * at noon.
 *
 * Two reasons this is more complicated than `new Date(serial * 86400000)`:
 *
 *   1. Excel's epoch is December 30, 1899 — not January 1, 1900.
 *      This is because of Excel's 1900-leap-year bug: Excel treats
 *      1900 as a leap year (it isn't), which adds a phantom day at
 *      Feb 29, 1900. To get the right JavaScript Date, anchor at
 *      Dec 30, 1899 and the math works out for any date after
 *      March 1, 1900 (which covers everything we care about).
 *
 *   2. Microsoft Graph sometimes returns dates as strings (already
 *      formatted), sometimes as serial numbers (raw cell values),
 *      depending on how the column was set up. Code that reads
 *      Excel dates needs to handle both shapes.
 *
 * This snippet provides:
 *
 *   - excelSerialToDate(serial)    — serial → Date
 *   - dateToExcelSerial(date)      — Date → serial
 *   - parseAnyDate(val)            — accepts serial, ISO, German,
 *                                    or JS Date; returns Date
 *   - formatDate(date, locale)     — Date → display string
 *
 * Used in: n8n Code node, anywhere date columns come back from
 * Microsoft Graph and need to be reasoned about as JavaScript Dates.
 */

// ── Excel serial → JS Date ────────────────────────────────────
function excelSerialToDate(serial) {
  if (serial === null || serial === undefined || serial === "") return null;

  const num = typeof serial === "string" ? parseFloat(serial) : serial;
  if (isNaN(num) || num < 0) {
    console.warn(`Invalid Excel serial: ${serial}`);
    return null;
  }

  // Anchor at Dec 30, 1899 to compensate for Excel's 1900 leap-year bug.
  // Works correctly for all dates after March 1, 1900.
  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const msPerDay = 86400000;

  const date = new Date(excelEpoch.getTime() + num * msPerDay);
  return isNaN(date.getTime()) ? null : date;
}

// ── JS Date → Excel serial ────────────────────────────────────
function dateToExcelSerial(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null;

  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const msPerDay = 86400000;
  return (date.getTime() - excelEpoch.getTime()) / msPerDay;
}

// ── Universal date parser ─────────────────────────────────────
// Accepts: Excel serial number, ISO 'YYYY-MM-DD', German 'DD.MM.YYYY',
// or a JS Date. Returns a JS Date or null.
function parseAnyDate(val) {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) return val;

  const s = String(val).trim();

  // German DD.MM.YYYY
  const m1 = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m1) return new Date(`${m1[3]}-${m1[2]}-${m1[1]}T00:00:00Z`);

  // ISO YYYY-MM-DD (with optional time)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s);

  // Excel serial — large numbers
  const num = parseFloat(s);
  if (!isNaN(num) && num > 40000) return excelSerialToDate(num);

  return null;
}

// ── Format Date for display ───────────────────────────────────
function formatDate(date, locale = "de", includeTime = true) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return "";

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  let datePart;
  if (locale === "en") {
    datePart = `${year}-${month}-${day}`;
  } else {
    datePart = `${day}.${month}.${year}`; // German
  }

  if (!includeTime) return datePart;
  return `${datePart} ${hours}:${minutes}`;
}

// ── Format range for human-readable display ───────────────────
function formatDateRange(fromDate, toDate, locale = "de") {
  const f = formatDate(fromDate, locale, false);
  const t = formatDate(toDate, locale, false);
  if (!f && !t) return "All time";
  if (!f) return `Until ${t}`;
  if (!t) return `From ${f}`;
  return `${f} — ${t}`;
}

// ── Export the utility set as the node's output ───────────────
return [
  {
    json: {
      // Pass through inputs
      ...$input.first().json,

      // Functions can't be serialized between n8n nodes; in
      // practice you copy this snippet into each node that needs
      // it, OR you use n8n's Workflow Static Data.
      // For testing, you can call the functions inline:
      _today_serial: dateToExcelSerial(new Date()),
      _today_display: formatDate(new Date(), "de"),
    },
  },
];
