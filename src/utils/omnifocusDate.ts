/**
 * OmniFocus Date Utilities
 *
 * This module provides deterministic date parsing and AppleScript date construction
 * to avoid AppleScript's locale-ambiguous date string parsing.
 *
 * Problem: AppleScript's `date "2026-01-21"` interprets hyphenated dates ambiguously,
 * often treating them as day-month-year, causing "2026-01-21" to become July 19, 2026.
 *
 * Solution: Parse ISO dates in TypeScript, then construct AppleScript dates from
 * explicit numeric components (year, month, day, hour, minute, second).
 */

/**
 * Parsed date components from an ISO date string
 */
export interface IsoDateParts {
  year: number;
  month: number;  // 1-12
  day: number;    // 1-31
  hour: number;   // 0-23
  minute: number; // 0-59
  second: number; // 0-59
  hasTime: boolean;
}

/**
 * AppleScript helper function that constructs a date from numeric parts.
 * This MUST be included at the top of any AppleScript that uses date setting.
 *
 * Why this works: Instead of relying on AppleScript's ambiguous string parsing,
 * we set each date component individually. The month is set using the month
 * constant list to avoid any locale issues.
 */
export const APPLESCRIPT_DATE_HELPERS = `
-- Helper function to create a date from numeric parts (avoids locale-dependent string parsing)
on makeDate(y, m, d, hh, mm, ss)
  set dt to current date
  set year of dt to y
  -- Use month constants to avoid locale issues
  set month of dt to item m of {January, February, March, April, May, June, July, August, September, October, November, December}
  set day of dt to d
  set time of dt to (hh * hours) + (mm * minutes) + ss
  return dt
end makeDate
`;

/**
 * Parse an ISO date string into numeric components.
 *
 * Supported formats:
 * - "YYYY-MM-DD" (date only, treated as local midnight)
 * - "YYYY-MM-DDTHH:mm" (datetime without seconds)
 * - "YYYY-MM-DDTHH:mm:ss" (datetime with seconds)
 * - "YYYY-MM-DDTHH:mm:ssZ" (UTC datetime)
 * - "YYYY-MM-DDTHH:mm:ss±HH:mm" (datetime with timezone offset)
 *
 * @param input - ISO format date string
 * @returns Parsed date parts
 * @throws Error if the input is not a valid ISO date format
 */
export function parseIsoDateInput(input: string): IsoDateParts {
  if (!input || typeof input !== 'string') {
    throw new Error(`Invalid date input: expected string, got ${typeof input}`);
  }

  const trimmed = input.trim();

  // Date-only format: YYYY-MM-DD
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = parseInt(dateOnlyMatch[1], 10);
    const month = parseInt(dateOnlyMatch[2], 10);
    const day = parseInt(dateOnlyMatch[3], 10);

    validateDateParts(year, month, day, 0, 0, 0);

    return {
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0,
      hasTime: false
    };
  }

  // Datetime format: YYYY-MM-DDTHH:mm[:ss[.sss]][Z|±HH:mm]
  const datetimeMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
  );

  if (datetimeMatch) {
    const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, timezone] = datetimeMatch;

    let year = parseInt(yearStr, 10);
    let month = parseInt(monthStr, 10);
    let day = parseInt(dayStr, 10);
    let hour = parseInt(hourStr, 10);
    let minute = parseInt(minuteStr, 10);
    let second = secondStr ? parseInt(secondStr, 10) : 0;

    // If timezone is specified (Z or ±HH:mm), convert to local time
    if (timezone) {
      // Parse as an instant and extract local components
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) {
        throw new Error(`Invalid date: "${trimmed}" could not be parsed as a valid datetime`);
      }
      year = date.getFullYear();
      month = date.getMonth() + 1; // getMonth() is 0-based
      day = date.getDate();
      hour = date.getHours();
      minute = date.getMinutes();
      second = date.getSeconds();
    }

    validateDateParts(year, month, day, hour, minute, second);

    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      hasTime: true
    };
  }

  throw new Error(
    `Invalid date format: "${trimmed}". ` +
    `Expected ISO format like "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm:ss". ` +
    `Examples: "2026-01-21", "2026-01-21T09:30:00"`
  );
}

/**
 * Validate date parts are within reasonable ranges
 */
function validateDateParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): void {
  if (year < 1900 || year > 2100) {
    throw new Error(`Invalid year: ${year}. Must be between 1900 and 2100.`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}. Must be between 1 and 12.`);
  }
  if (day < 1 || day > 31) {
    throw new Error(`Invalid day: ${day}. Must be between 1 and 31.`);
  }
  if (hour < 0 || hour > 23) {
    throw new Error(`Invalid hour: ${hour}. Must be between 0 and 23.`);
  }
  if (minute < 0 || minute > 59) {
    throw new Error(`Invalid minute: ${minute}. Must be between 0 and 59.`);
  }
  if (second < 0 || second > 59) {
    throw new Error(`Invalid second: ${second}. Must be between 0 and 59.`);
  }

  // Basic month-day validation
  const daysInMonth = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month]) {
    throw new Error(`Invalid day ${day} for month ${month}.`);
  }
}

/**
 * Generate an AppleScript expression that calls makeDate() with the given parts.
 *
 * @param parts - Parsed ISO date parts
 * @returns AppleScript expression like "my makeDate(2026, 1, 21, 0, 0, 0)"
 */
export function appleScriptDateExpr(parts: IsoDateParts): string {
  return `my makeDate(${parts.year}, ${parts.month}, ${parts.day}, ${parts.hour}, ${parts.minute}, ${parts.second})`;
}

/**
 * Check if a string is a supported ISO date format.
 * Use this for Zod schema validation.
 *
 * @param input - String to check
 * @returns true if the string is a valid ISO date format
 */
export function isSupportedIsoDateInput(input: string): boolean {
  try {
    parseIsoDateInput(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format an ISO date string for display in a locale-safe way.
 * This avoids the off-by-one-day issue when JavaScript parses "YYYY-MM-DD" as UTC.
 *
 * @param input - ISO date string
 * @param locale - Optional locale string (defaults to user's locale)
 * @returns Formatted date string for display
 */
export function formatIsoForDisplay(input: string, locale?: string): string {
  try {
    const parts = parseIsoDateInput(input);
    // Construct date in local timezone
    const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return date.toLocaleDateString(locale);
  } catch {
    // Fallback: try native parsing (may have off-by-one issue)
    return new Date(input).toLocaleDateString(locale);
  }
}
