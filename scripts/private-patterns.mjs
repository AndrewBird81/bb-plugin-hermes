// Generic personal-data patterns for scripts/check-private.mjs (docs/variables.md); private.env values come on top.

/** A local time zone that isn't UTC: recordings and screenshots run in UTC (docs/variables.md). Case-sensitive. */
export const TIME_ZONE_PATTERNS = [
  // Hermes' system-prompt line, "Conversation started: … (<abbreviation>, UTC<±hh:mm>)": only UTC+00:00 passes.
  ['local time zone', /, UTC(?!\+00:00)[+-]\d{2}:\d{2}\)/g],
  ['local time zone', /\bUTC-0[56]:00\b/g],
  ['local time zone', /\bGMT-0[56]00\b/g],
  ['local time zone', /\bCentral (?:Standard|Daylight) Time\b/g],
  ['local time zone', /\bAmerica\/Chicago\b/g],
];

export const GENERIC_PATTERNS = [
  ['tailnet IP', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g],
  ['*.ts.net name', /[a-z0-9-]+\.ts\.net\b/gi],
  ['/Users/<name>/ path', /\/Users\/[^/\s"'`<>]+\//g],
  ['email', /(?<![\w.+-])[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi],
  ['Hermes session id', /\b\d{8}_\d{6}_[0-9a-f]{6,}\b/g],
  ...TIME_ZONE_PATTERNS,
];
