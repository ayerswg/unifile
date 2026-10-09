/**
 * Formula function help — one line per function and an Excel-style signature.
 *
 * Shared by the {document} tables' completion (src/dsl/markdown-tables.js),
 * the {spreadsheet} text editor (src/dsl/spreadsheet.js) and the grid's
 * in-cell formula assist (src/core/sheet/formula-edit.js). Pure data, no DOM.
 */

const DETAIL_SRC = `SUM:add numbers|AVERAGE:mean|AVG:mean|MIN:smallest|MAX:largest|COUNT:count numbers|COUNTA:count non-empty|COUNTBLANK:count empty|PRODUCT:multiply|MEDIAN:middle value|STDEV:sample std dev|SUMIF:sum if criteria|COUNTIF:count if criteria|AVERAGEIF:mean if criteria|SUMPRODUCT:Σ a×b|LARGE:k-th largest|SMALL:k-th smallest|RANK:rank in list|IF:if(test, yes, no)|IFERROR:value or fallback|AND:all true|OR:any true|NOT:negate|ISBLANK:is empty?|ISNUMBER:is a number?|ISTEXT:is text?|ISERROR:is an error?|ROUND:round to decimals|ROUNDUP:round away from 0|ROUNDDOWN:round toward 0|INT:round down|TRUNC:drop decimals|CEILING:up to multiple|FLOOR:down to multiple|ABS:absolute|MOD:remainder|POWER:x^y|SQRT:square root|EXP:e^x|LN:natural log|LOG:log base b|LOG10:log base 10|PI:3.14159…|LEN:text length|UPPER:UPPER CASE|LOWER:lower case|PROPER:Title Case|TRIM:trim spaces|LEFT:first n chars|RIGHT:last n chars|MID:substring|FIND:position (case-sensitive)|SEARCH:position|SUBSTITUTE:replace text|CONCAT:join text|CONCATENATE:join text|TEXTJOIN:join with separator|REPT:repeat text|TEXT:format a number|VALUE:text → number|N:→ number|VLOOKUP:look up by first column|HLOOKUP:look up by first row|INDEX:cell of a range|MATCH:position in a range|ROW:row number|COLUMN:column number|ROWS:rows in range|COLUMNS:columns in range|TODAY:today's date|NOW:date and time now|DATE:a date from y, m, d|DATEVALUE:text → date|YEAR:year of a date|MONTH:month of a date|DAY:day of a date|HOUR:hour of a time|MINUTE:minute of a time|WEEKDAY:day of the week|DAYS:days between dates|EDATE:months later|EOMONTH:end of month|DATEDIF:difference in y/m/d`;

/** `{ SUM: 'add numbers', … }` — the one-line descriptions. */
export const FN_DETAIL = Object.fromEntries(DETAIL_SRC.split('|').map(s => { const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; }));

const SIGNATURE_SRC = `ABS(number)|AND(logical1, [logical2], …)|AVERAGE(number1, [number2], …)|AVERAGEIF(range, criteria, [average_range])|AVG(number1, [number2], …)|CEILING(number, significance)|COLUMN([reference])|COLUMNS(array)|CONCAT(text1, [text2], …)|CONCATENATE(text1, [text2], …)|COUNT(value1, [value2], …)|COUNTA(value1, [value2], …)|COUNTBLANK(range)|COUNTIF(range, criteria)|DATE(year, month, day)|DATEDIF(start_date, end_date, unit)|DATEVALUE(date_text)|DAY(date)|DAYS(end_date, start_date)|EDATE(start_date, months)|EOMONTH(start_date, months)|EXP(number)|FIND(find_text, within_text, [start_num])|FLOOR(number, significance)|HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])|HOUR(time)|IF(logical_test, value_if_true, [value_if_false])|IFERROR(value, value_if_error)|INDEX(array, row_num, [column_num])|INT(number)|ISBLANK(value)|ISERROR(value)|ISNUMBER(value)|ISTEXT(value)|LARGE(array, k)|LEFT(text, [num_chars])|LEN(text)|LN(number)|LOG(number, [base])|LOG10(number)|LOWER(text)|MATCH(lookup_value, lookup_array, [match_type])|MAX(number1, [number2], …)|MEDIAN(number1, [number2], …)|MID(text, start_num, num_chars)|MIN(number1, [number2], …)|MINUTE(time)|MOD(number, divisor)|MONTH(date)|N(value)|NOT(logical)|NOW()|OR(logical1, [logical2], …)|PI()|POWER(number, power)|PRODUCT(number1, [number2], …)|PROPER(text)|RANK(number, ref, [order])|REPT(text, number_times)|RIGHT(text, [num_chars])|ROUND(number, num_digits)|ROUNDDOWN(number, num_digits)|ROUNDUP(number, num_digits)|ROW([reference])|ROWS(array)|SEARCH(find_text, within_text, [start_num])|SMALL(array, k)|SQRT(number)|STDEV(number1, [number2], …)|SUBSTITUTE(text, old_text, new_text, [instance_num])|SUM(number1, [number2], …)|SUMIF(range, criteria, [sum_range])|SUMPRODUCT(array1, [array2], …)|TEXT(value, format_text)|TEXTJOIN(delimiter, ignore_empty, text1, [text2], …)|TODAY()|TRIM(text)|TRUNC(number, [num_digits])|UPPER(text)|VALUE(text)|VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])|WEEKDAY(date, [return_type])|YEAR(date)`;

/** `{ SUM: ['number1', '[number2]', '…'], … }` — the parameter lists. */
export const FN_PARAMS = Object.fromEntries(SIGNATURE_SRC.split('|').map(s => {
  const i = s.indexOf('(');
  const inner = s.slice(i + 1, -1).trim();
  return [s.slice(0, i), inner ? inner.split(/,\s*/) : []];
}));

/** The parameter list of a function (empty for a name without one). */
export function functionParams(name) { return FN_PARAMS[String(name).toUpperCase()] ?? null; }

/** `SUM(number1, [number2], …)` — the whole signature as text. */
export function functionSignature(name) {
  const n = String(name).toUpperCase();
  const p = FN_PARAMS[n];
  return p ? `${n}(${p.join(', ')})` : `${n}(…)`;
}
