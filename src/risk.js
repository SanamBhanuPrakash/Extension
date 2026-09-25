/**
 * One number.
 *
 * A findings list is the right output for an engineer and the wrong one for
 * everyone else. Asked to judge a list of nine items in the two seconds before
 * pressing Enter, most people press Enter.
 *
 * So the panel leads with a 0–100 exposure score and one sentence explaining
 * what drove it. The score is deliberately simple and fully explainable — every
 * contribution is listed, and the arithmetic is in this file. A score nobody
 * can reconstruct is a score nobody should trust.
 */

const SEVERITY_WEIGHT = { critical: 34, high: 18, medium: 8, low: 2 };
const CONFIDENCE_FACTOR = { certain: 1, likely: 0.85, possible: 0.6 };

/**
 * @param {Array} findings
 * @param {object|null} table  result of detectTable(), if any
 * @returns {{score:number, band:string, headline:string, drivers:Array<{label,points}>}}
 */
export function exposureScore(findings, table = null) {
  const drivers = [];
  let raw = 0;

  // Distinct kinds, not raw count: forty email addresses is one problem,
  // and the table below is the thing that should carry volume.
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, []);
    byRule.get(f.ruleId).push(f);
  }

  for (const [, group] of byRule) {
    const f = group[0];
    const base = SEVERITY_WEIGHT[f.severity] ?? 4;
    // Repeats add, with sharply diminishing returns.
    const repeat = 1 + Math.min(0.6, Math.log2(group.length) * 0.18);
    const points = base * (CONFIDENCE_FACTOR[f.confidence] ?? 0.7) * repeat;
    raw += points;
    drivers.push({
      label: group.length > 1 ? `${group.length}× ${f.label}` : f.label,
      points: Math.round(points),
      severity: f.severity,
    });
  }

  if (table) {
    // Volume is the dominant term for bulk disclosure, and it should be: one
    // customer record going astray is an incident, ten thousand is a breach
    // with a 72-hour notification clock attached. Width matters too — a row
    // with name, email, phone and card is a richer record than a row of emails.
    const breadth = Math.min(1.5, 1 + 0.12 * (table.personalColumns.length - 1));
    const volume = Math.min(72, (18 + Math.log10(Math.max(10, table.rows)) * 20) * breadth);
    raw += volume;
    drivers.push({
      label: `${table.rows.toLocaleString()} records in a table`,
      points: Math.round(volume),
      severity: table.rows >= 100 ? 'critical' : 'high',
    });
  }

  // Compress into 0–100 so the top of the scale stays meaningful: a prompt with
  // twenty secrets should not read the same as one with five, but both are bad.
  const score = Math.round(100 * (1 - Math.exp(-raw / 45)));
  drivers.sort((a, b) => b.points - a.points);

  const band = score >= 70 ? 'severe' : score >= 40 ? 'elevated' : score >= 15 ? 'low' : 'minimal';
  const top = drivers.slice(0, 2).map((d) => d.label.toLowerCase());
  const headline = drivers.length === 0
    ? 'Nothing sensitive found.'
    : top.length === 1
      ? `Driven by ${top[0]}.`
      : `Driven mainly by ${top[0]} and ${top[1]}.`;

  return { score, band, headline, drivers };
}

/** What the band means, in words the reader does not have to decode. */
export const BAND_TEXT = {
  severe: 'Do not send this without redacting.',
  elevated: 'Worth a second look before sending.',
  low: 'Minor exposure. Your call.',
  minimal: 'Nothing worth stopping for.',
};
