/**
 * Bulk-record detection.
 *
 * The single most important thing this engine does for a non-engineer.
 *
 * A pattern scanner looks at a pasted customer export and reports "312 email
 * addresses". That is technically true and practically useless: nobody reads
 * 312 findings, and the number does not convey what actually happened. What
 * happened is a bulk disclosure of a customer database to a third party, which
 * is a different category of event from pasting one address, and in most
 * jurisdictions a different category of legal problem.
 *
 * So: detect the *shape* of the data, not only the values in it. A table with
 * an email column and 312 rows is one finding — "312 customer records" — with
 * severity driven by volume.
 *
 * Column meaning is inferred two ways, and the second matters more:
 *   1. the header, matched against a lexicon; and
 *   2. the values, by running the detector engine down the column.
 * Header inference alone fails on exports with columns called `c_1` or
 * `field_7`, which is most of them.
 */

const DELIMITERS = [
  { char: '\t', name: 'tab-separated' },
  { char: ',', name: 'comma-separated' },
  { char: '|', name: 'pipe-separated' },
  { char: ';', name: 'semicolon-separated' },
];

/** Header names that announce what a column holds, across common exports. */
const HEADER_LEXICON = [
  [/^(?:e[-_ ]?mail|email[-_ ]?address|mail)$/i, 'email', 'Email address'],
  [/^(?:phone|mobile|cell|telephone|tel|contact[-_ ]?(?:no|number)|msisdn)$/i, 'phone', 'Phone number'],
  [/^(?:ssn|social[-_ ]?security(?:[-_ ]?number)?)$/i, 'ssn', 'Social Security number'],
  [/^(?:aadhaar|aadhar|uid|uidai)$/i, 'aadhaar', 'Aadhaar number'],
  [/^(?:pan|pan[-_ ]?(?:no|number|card))$/i, 'pan', 'PAN'],
  [/^(?:gstin|gst[-_ ]?(?:no|number))$/i, 'gstin', 'GSTIN'],
  [/^(?:card|card[-_ ]?(?:no|number)|pan[-_ ]?number|cc[-_ ]?num)$/i, 'card', 'Payment card'],
  [/^(?:iban|account[-_ ]?(?:no|number)|acct|bank[-_ ]?account)$/i, 'account', 'Bank account'],
  [/^(?:dob|date[-_ ]?of[-_ ]?birth|birth[-_ ]?date|birthday)$/i, 'dob', 'Date of birth'],
  [/^(?:salary|ctc|compensation|pay|annual[-_ ]?pay|base[-_ ]?pay|wage)$/i, 'salary', 'Compensation'],
  [/^(?:address|addr|street|address[-_ ]?line[-_ ]?1|residence)$/i, 'address', 'Postal address'],
  [/^(?:passport|passport[-_ ]?(?:no|number))$/i, 'passport', 'Passport number'],
  [/^(?:password|passwd|pwd|secret|token|api[-_ ]?key)$/i, 'secret', 'Credential'],
  [/^(?:name|full[-_ ]?name|first[-_ ]?name|last[-_ ]?name|surname|customer[-_ ]?name|employee[-_ ]?name)$/i, 'name', 'Person name'],
  [/^(?:diagnosis|condition|icd|medication|prescription|treatment)$/i, 'health', 'Health information'],
  [/^(?:ip|ip[-_ ]?address|device[-_ ]?id|imei|mac)$/i, 'device', 'Device identifier'],
];

/** Which inferred column kinds count as personal data for the summary. */
const PERSONAL = new Set(['email', 'phone', 'ssn', 'aadhaar', 'pan', 'card',
  'account', 'dob', 'salary', 'address', 'passport', 'name', 'health', 'device']);

/** Rule ids that, seen down a column, imply the column's meaning. */
const RULE_TO_KIND = {
  email: 'email', phone_india: 'phone', us_ssn: 'ssn', aadhaar: 'aadhaar',
  pan_india: 'pan', gstin: 'gstin', payment_card: 'card', iban: 'account',
  brazil_cpf: 'ssn', canada_sin: 'ssn', uk_nino: 'ssn', upi_vpa: 'account',
  indian_passport: 'passport', imei: 'device', indian_dl: 'passport',
};

const KIND_LABEL = {
  email: 'Email address', phone: 'Phone number', ssn: 'National identity number',
  aadhaar: 'Aadhaar number', pan: 'PAN', gstin: 'GSTIN', card: 'Payment card',
  account: 'Bank or payment account', dob: 'Date of birth', salary: 'Compensation',
  address: 'Postal address', passport: 'Passport number', secret: 'Credential',
  name: 'Person name', health: 'Health information', device: 'Device identifier',
};

function splitRow(line, delimiter) {
  // Minimal CSV awareness: respect double quotes so an address containing a
  // comma does not inflate the column count and defeat the consistency check.
  if (delimiter !== ',') return line.split(delimiter);
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const clean = (s) => s.trim().replace(/^["']|["']$/g, '');

/**
 * How many rows are split into cells.
 *
 * A 50,000-row export is characterised just as well by its first two thousand
 * rows, and splitting all of it costs a browser tab. The reported row count is
 * still the true one — it is counted cheaply, without splitting — because the
 * count is the finding.
 */
const MAX_ROWS_PROCESSED = 2000;

/**
 * Finds the delimiter that produces the most consistent column count across
 * the most lines. Consistency is the signal that this is a table rather than
 * prose that happens to contain commas.
 */
function detectShape(lines) {
  let best = null;
  for (const { char, name } of DELIMITERS) {
    const counts = lines.map((l) => splitRow(l, char).length);
    const tally = new Map();
    for (const n of counts) if (n >= 2) tally.set(n, (tally.get(n) || 0) + 1);
    if (!tally.size) continue;
    const [cols, rows] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const consistency = rows / lines.length;
    const score = consistency * Math.min(cols, 12) * Math.log2(rows + 1);
    if (consistency >= 0.7 && rows >= 3 && (!best || score > best.score)) {
      best = { delimiter: char, name, cols, rows, consistency, score };
    }
  }
  return best;
}

/** A header row is one whose cells are short, wordy and mostly non-numeric. */
function looksLikeHeader(cells) {
  const wordy = cells.filter((c) => /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(clean(c))).length;
  const numeric = cells.filter((c) => /^[0-9.,-]+$/.test(clean(c))).length;
  return wordy >= Math.ceil(cells.length * 0.6) && numeric === 0;
}

/**
 * @param {string} text
 * @param {(s: string) => Array<{ruleId: string}>} probe  usually a bound scan()
 * @returns {null | {rows, cols, kind, columns, personalColumns, delimiterName, start, end}}
 */
export function detectTable(text, probe) {
  if (typeof text !== 'string' || text.length < 40) return null;
  const rawLines = text.split('\n');
  // Only consider the contiguous block of non-empty lines; a table embedded in
  // prose still has to be a block.
  const lines = rawLines.filter((l) => l.trim().length > 0);
  if (lines.length < 4) return null;

  // Markdown tables: strip the alignment row and the outer pipes.
  const isMarkdown = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= lines.length * 0.7;
  const working = isMarkdown
    ? lines.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, ''))
    : lines;
  if (working.length < 3) return null;

  const shape = detectShape(working);
  if (!shape) return null;

  // Offsets are carried per row, by position.
  //
  // An earlier version keyed them by the line's TEXT, which silently collapsed
  // every identical row to one entry — so a 5,000-row export of repeated rows
  // pointed all of its findings at the same offset.
  const rows = [];
  let totalRows = 0;
  {
    let from = 0;
    for (const line of working) {
      const at = text.indexOf(line, from);
      if (at >= 0) from = at + line.length;
      if (rows.length >= MAX_ROWS_PROCESSED) {
        // Past the cap, only count: a cheap delimiter tally is enough to know
        // the row belongs to the table.
        let n = 1;
        for (let i = 0; i < line.length; i++) if (line[i] === shape.delimiter) n++;
        if (n === shape.cols) totalRows++;
        continue;
      }
      const cells = splitRow(line, shape.delimiter);
      if (cells.length === shape.cols) { rows.push({ line, cells, start: at }); totalRows++; }
    }
  }
  const grid = rows.map((r) => r.cells.map(clean));
  if (grid.length < 3) return null;

  const header = looksLikeHeader(grid[0]) ? grid[0] : null;
  const body = header ? grid.slice(1) : grid;
  const bodyRows = header ? rows.slice(1) : rows;
  if (body.length < 2) return null;

  // Sample rather than scan every cell: a 50,000-row paste must not stall the
  // browser, and 40 values is ample to classify a column.
  const SAMPLE = 40;
  const step = Math.max(1, Math.floor(body.length / SAMPLE));
  const columns = [];

  for (let c = 0; c < shape.cols; c++) {
    const name = header ? header[c] : null;
    let kind = null;
    let label = null;

    if (name) {
      for (const [re, k, l] of HEADER_LEXICON) {
        if (re.test(name)) { kind = k; label = l; break; }
      }
    }

    // Value-based inference. This is the part that survives `field_7` headers.
    let filled = 0;
    if (!kind) {
      const votes = new Map();
      let sampled = 0;
      for (let rIdx = 0; rIdx < body.length && sampled < SAMPLE; rIdx += step) {
        const value = body[rIdx][c];
        sampled++;
        if (!value) continue;
        let hits;
        try { hits = probe(value); } catch { hits = []; }
        for (const h of hits) {
          const k = RULE_TO_KIND[h.ruleId];
          if (k) votes.set(k, (votes.get(k) || 0) + 1);
        }
      }
      const [top] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
      // A column is that kind only if most sampled values agree.
      if (top && top[1] >= Math.max(2, Math.floor(sampled * 0.6))) {
        kind = top[0];
        label = KIND_LABEL[kind];
      }
    }

    for (const row of body) if (row[c]) filled++;
    columns.push({ index: c, name: name || null, kind, label: label || KIND_LABEL[kind] || null, filled });
  }

  const personalColumns = columns.filter((col) => col.kind && PERSONAL.has(col.kind));
  if (!personalColumns.length) return null;

  /**
   * Where each value in a personal column sits in the original text.
   *
   * This is what makes a bulk paste redactable. A `phone` column's values are
   * phone numbers because the column says so — read alone, each one is just
   * ten digits, and the value-level rule correctly refuses to guess.
   */
  function cellSpans(limit = 1200) {
    const out = [];
    for (const col of personalColumns) {
      for (let r = 0; r < bodyRows.length && out.length < limit; r++) {
        const raw = bodyRows[r].cells[col.index];
        if (!raw) continue;
        const value = clean(raw);
        if (!value || value.length < 3) continue;
        const lineStart = bodyRows[r].start;
        if (lineStart === undefined || lineStart < 0) continue;
        const within = bodyRows[r].line.indexOf(value);
        if (within < 0) continue;
        out.push({ start: lineStart + within, end: lineStart + within + value.length, value, kind: col.kind, label: col.label });
      }
    }
    return out;
  }

  return {
    // The true row count, including rows past the processing cap.
    rows: header ? totalRows - 1 : totalRows,
    processedRows: body.length,
    cols: shape.cols,
    cellSpans,
    delimiterName: isMarkdown ? 'markdown table' : shape.name,
    hasHeader: Boolean(header),
    columns,
    personalColumns,
  };
}

/** Volume is the thing that changes the nature of the disclosure. */
export function tableSeverity(rows) {
  if (rows >= 100) return 'critical';
  if (rows >= 20) return 'high';
  return 'medium';
}

/** One sentence a non-engineer can act on. */
export function describeTable(table) {
  const kinds = table.personalColumns
    .map((c) => (c.label || c.kind).toLowerCase())
    .filter((v, i, a) => a.indexOf(v) === i);
  const list = kinds.length === 1 ? kinds[0]
    : `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;
  const noun = table.rows >= 20 ? 'records' : 'rows';
  const shape = table.delimiterName === 'markdown table'
    ? 'a markdown table' : `${table.delimiterName} values`;
  return `${table.rows.toLocaleString()} ${noun} of personal data — ${list} — as ${shape}. ` +
    `This is a bulk disclosure, not a single value.`;
}
