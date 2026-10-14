"""Rewrites for constructs sqlglot prints verbatim (or garbled) although the target engine rejects or silently changes them.

Each rule reads the statement (already in sqlglot's neutral tree) and the target id, replaces the node with a form the
engine documents, or reports an issue: "error" = the converted SQL will not run / loses meaning on the target, "warning" =
it runs but is an approximation. Rules are grouped: date arithmetic, EXTRACT / DATE_TRUNC, string functions, DDL, row limits.
Every rule here is covered by tests/sql_engine_corpus.py (known answers) and, where SQLite or DuckDB can run the output,
by execution in tests/sql_engine_e2e.py."""
from __future__ import annotations

import re

import sqlglot
from sqlglot import exp

from .common import Issue, issue, sg_name

_UNITS = ("YEAR", "QUARTER", "MONTH", "WEEK", "DAY", "HOUR", "MINUTE", "SECOND")
_PLURAL = {u + "S": u for u in _UNITS}
_INTERVAL_TEXT = re.compile(r"^\s*([+-]?\d+)\s+([A-Za-z]+)\s*$")


def apply(statement: exp.Expression, source: str, target: str, issues: list[Issue]) -> exp.Expression:
    """Run every rule; returns the (possibly new root) statement."""
    statement = _now(statement)
    _sqlite_time_functions(statement, source, target, issues)  # before date arithmetic: it emits `x +- INTERVAL` for that rule to spell per target
    statement = _date_arithmetic(statement, target, issues)
    _date_diff(statement, target, issues)
    _date_trunc(statement, target, issues)
    _extract(statement, target, issues)
    _string_agg(statement, target, issues)
    _text_functions(statement, source, target, issues)
    statement = _truncate(statement, target, issues)
    _ddl(statement, source, target, issues)
    _row_limits(statement, target, issues)
    return statement


# ---------------------------------------------------------------- small helpers

def _unit(node: exp.Expression | None) -> str | None:
    if node is None:
        return None
    name = node.name.upper() if isinstance(node, (exp.Var, exp.Literal, exp.Column, exp.Identifier)) else ""
    name = _PLURAL.get(name, name)
    return name if name in _UNITS else None


def _int(node: exp.Expression | None) -> int | None:
    if isinstance(node, exp.Literal) and not node.is_string:
        try:
            return int(node.this)
        except ValueError:
            return None
    if isinstance(node, exp.Literal) and node.is_string and re.fullmatch(r"[+-]?\d+", node.this.strip()):
        return int(node.this)
    if isinstance(node, exp.Neg):
        inner = _int(node.this)
        return -inner if inner is not None else None
    return None


def _num(value: int) -> exp.Expression:
    return exp.Neg(this=exp.Literal.number(-value)) if value < 0 else exp.Literal.number(value)


def _scale(amount: exp.Expression, factor: int) -> exp.Expression:
    if factor == 1:
        return amount
    value = _int(amount)
    if value is not None:
        return _num(value * factor)
    return exp.Mul(this=exp.Paren(this=amount) if isinstance(amount, exp.Binary) else amount, expression=exp.Literal.number(factor))


def _negate(amount: exp.Expression) -> exp.Expression:
    value = _int(amount)
    if value is not None:
        return _num(-value)
    return exp.Neg(this=exp.Paren(this=amount) if isinstance(amount, exp.Binary) else amount)


def _bare(node: exp.Expression) -> exp.Expression:
    """Drop the TIME_STR_TO_TIME(...) wrapper sqlglot's T-SQL reader puts around DATEDIFF/DATEADD arguments."""
    while isinstance(node, exp.TimeStrToTime):
        node = node.this
    return node


def _fn(name: str, *args: exp.Expression) -> exp.Anonymous:
    return exp.Anonymous(this=name, expressions=list(args))


def _unit_var(unit: str) -> exp.Var:
    return exp.Var(this=unit)


def _now(statement: exp.Expression) -> exp.Expression:
    """MySQL's NOW() reads as an unknown function, so every target would print NOW(): normalise to CURRENT_TIMESTAMP, which each generator spells its own way (GETDATE() for T-SQL...)."""
    for node in list(statement.find_all(exp.Anonymous)):
        if node.name.upper() == "NOW" and not node.expressions:
            node.replace(exp.CurrentTimestamp())
    return statement


# ---------------------------------------------------------------- SQLite date/time functions: datetime('now'), date(x, '+1 day')

_SQLITE_CURRENT = {"DATE": exp.CurrentDate, "DATETIME": exp.CurrentTimestamp, "TIME": exp.CurrentTimestamp}
_SQLITE_CAST_TYPE = {"DATE": "DATE", "DATETIME": "TIMESTAMP", "TIME": "TIME"}
_SQLITE_MODIFIER = re.compile(r"^\s*([+-]?\d+)\s+(second|minute|hour|day|month|year)s?\s*$", re.IGNORECASE)


def _sqlite_time_args(node: exp.Expression) -> list[exp.Expression]:
    """sqlglot reads date() as exp.Date (second argument in `zone`) but datetime()/time() as plain function calls."""
    if isinstance(node, exp.Date):
        return [a for a in [node.this, node.args.get("zone"), *(node.expressions or [])] if a is not None]
    return list(node.expressions)


def _sqlite_time_functions(statement: exp.Expression, source: str, target: str, issues: list[Issue]) -> None:
    """SQLite's datetime()/date()/time() exist nowhere else, yet every generator printed them verbatim ("No issues").

    'now' becomes the target's CURRENT_TIMESTAMP/DATE/TIME, a plain value becomes a CAST, simple `+N unit` modifiers become
    interval arithmetic (which the date rules then spell per target); modifiers with no portable meaning ('start of month',
    'unixepoch', 'localtime', 'weekday 1') are reported as errors and left as written."""
    if source != "sqlite" or target == "sqlite":
        return
    for node in list(statement.find_all(exp.Anonymous, exp.Date)):
        name = "DATE" if isinstance(node, exp.Date) else node.name.upper()
        if name not in _SQLITE_CURRENT:
            continue
        args = _sqlite_time_args(node)
        if not args:
            continue
        base, modifiers = args[0], args[1:]
        steps: list[tuple[int, str]] = []
        unsupported: str | None = None
        for modifier in modifiers:
            match = _SQLITE_MODIFIER.match(modifier.this) if isinstance(modifier, exp.Literal) and modifier.is_string else None
            if match is None:
                unsupported = modifier.sql("sqlite")
                break
            steps.append((int(match.group(1)), match.group(2).upper()))
        if unsupported is not None:
            issues.append(issue(f"SQLite {name.lower()}(…, {unsupported}) has no equivalent in {target}: write it by hand (INTERVAL arithmetic, DATE_TRUNC for 'start of …', TO_TIMESTAMP for 'unixepoch'). It was not converted: what is printed for it is not valid {target}.", "error"))
            continue
        is_now = isinstance(base, exp.Literal) and base.is_string and base.this.strip().lower() == "now"
        if is_now:
            value: exp.Expression = _SQLITE_CURRENT[name]()
            if name == "TIME":  # CURRENT_TIME() is not valid in PostgreSQL and does not exist in T-SQL/Oracle: cast the timestamp instead
                value = exp.Cast(this=value, to=exp.DataType.build("TIME"))
                if target == "oracle":
                    issues.append(issue("Oracle has no TIME type: time('now') cannot be cast; use TO_CHAR(SYSTIMESTAMP, 'HH24:MI:SS') for the time of day as text.", "error"))
        else:
            value = exp.Cast(this=base.copy(), to=exp.DataType.build(_SQLITE_CAST_TYPE[name]))
            if not steps:
                issues.append(issue(f"SQLite {name.lower()}(x) normalises text and numbers to 'YYYY-MM-DD HH:MM:SS' text; CAST(x AS {_SQLITE_CAST_TYPE[name]}) only works when x is already a valid {_SQLITE_CAST_TYPE[name].lower()} literal.", "warning"))
        for amount, unit in steps:
            interval = exp.Interval(this=exp.Literal.string(str(abs(amount))), unit=_unit_var(unit))
            value = (exp.Add if amount >= 0 else exp.Sub)(this=value, expression=interval)
        node.replace(value)


# ---------------------------------------------------------------- date arithmetic: DATEADD / DATE_SUB / x +- INTERVAL

_INTERVAL_TARGETS = {"sqlite", "oracle", "tsql", "spark", "hive", "clickhouse"}


def _date_arithmetic(statement: exp.Expression, target: str, issues: list[Issue]) -> exp.Expression:
    if target in _INTERVAL_TARGETS:
        # d + INTERVAL '5 days' / d - INTERVAL 5 DAY  ->  DateAdd (INTERVAL literals are not portable: sqlite has none, Oracle wants singular units)
        for node in list(statement.find_all(exp.Add, exp.Sub)):
            interval = node.expression if isinstance(node.expression, exp.Interval) else None
            if interval is None:
                continue
            amount, unit = _interval_parts(interval)
            if amount is None or unit is None:
                continue
            if isinstance(node, exp.Sub):
                amount = _negate(amount)
            replacement = exp.DateAdd(this=node.this.copy(), expression=amount, unit=_unit_var(unit))
            if node is statement:
                statement = replacement
            else:
                node.replace(replacement)
    if target in ("sqlite", "oracle", "tsql"):
        for node in list(statement.find_all(exp.DateSub)):  # sqlglot leaves DATE_SUB(d, '2', MONTH) here, which these engines do not have
            unit = _unit(node.args.get("unit"))
            if unit is None:
                continue
            node.replace(exp.DateAdd(this=node.this.copy(), expression=_negate(node.expression.copy()), unit=_unit_var(unit)))
    if target in ("sqlite", "oracle", "spark", "hive", "bigquery"):
        for node in list(statement.find_all(exp.DateAdd)):
            unit = _unit(node.args.get("unit"))
            replacement = _date_add_for(node.this.copy(), node.expression.copy(), unit, target, issues) if unit else None
            if replacement is not None:
                if node is statement:
                    statement = replacement
                else:
                    node.replace(replacement)
    return statement


def _interval_parts(interval: exp.Interval) -> tuple[exp.Expression | None, str | None]:
    this, unit_node = interval.this, interval.args.get("unit")
    if unit_node is not None:
        unit = _unit(unit_node)
        amount = this.copy() if isinstance(this, exp.Expression) else None
        value = _int(amount)
        return (_num(value) if value is not None else amount), unit
    if isinstance(this, exp.Literal) and this.is_string:
        match = _INTERVAL_TEXT.match(this.this)
        if match:
            unit = _PLURAL.get(match.group(2).upper(), match.group(2).upper())
            return _num(int(match.group(1))), unit if unit in _UNITS else None
    return None, None


def _date_add_for(date: exp.Expression, amount: exp.Expression, unit: str, target: str, issues: list[Issue]) -> exp.Expression | None:
    n = _int(amount)
    if n is not None:
        amount = _num(n)  # '1' (MySQL INTERVAL 1 DAY reads as a string) -> 1
    date = _bare(date)
    if target == "sqlite":
        days = {"DAY": 1, "WEEK": 7}
        months = {"MONTH": 1, "QUARTER": 3, "YEAR": 12}
        if unit in days or unit in months:
            factor = days.get(unit) or months[unit]
            word = "days" if unit in days else "months"
            func = "DATE"
        else:
            factor, word, func = 1, unit.lower() + "s", "DATETIME"  # hours / minutes / seconds need DATETIME or the time part is lost
        scaled = _scale(amount, factor)
        modifier: exp.Expression = exp.Literal.string(f"{_int(scaled)} {word}") if _int(scaled) is not None else exp.DPipe(this=exp.Paren(this=scaled), expression=exp.Literal.string(f" {word}"))
        if func == "DATE":
            issues.append(issue("SQLite DATE(x, '+N days/months/years') drops a time-of-day part (use DATETIME(...) for timestamps) and month arithmetic overflows (Jan 31 + 1 month = Mar 3) instead of clamping to the month end.", "warning"))
        return _fn(func, date, modifier)
    if target == "oracle":
        if unit in ("DAY", "HOUR", "MINUTE", "SECOND", "WEEK"):
            interval_unit = "DAY" if unit == "WEEK" else unit
            return exp.Add(this=date, expression=_fn("NUMTODSINTERVAL", _scale(amount, 7 if unit == "WEEK" else 1), exp.Literal.string(interval_unit)))
        return _fn("ADD_MONTHS", date, _scale(amount, {"MONTH": 1, "QUARTER": 3, "YEAR": 12}[unit]))
    if target in ("spark", "hive"):
        if unit in ("DAY", "WEEK"):
            return _fn("DATE_ADD", date, _scale(amount, 7 if unit == "WEEK" else 1))
        if unit in ("MONTH", "QUARTER", "YEAR"):
            return _fn("ADD_MONTHS", date, _scale(amount, {"MONTH": 1, "QUARTER": 3, "YEAR": 12}[unit]))
        if n is None:
            issues.append(issue(f"{target}: adding a non-literal number of {unit.lower()}s needs make_interval/INTERVAL arithmetic that cannot be written portably; sqlglot's DATE_ADD(d, n) would add DAYS. Use a literal amount.", "error"))
            return None
        return exp.Add(this=date, expression=exp.Interval(this=exp.Literal.string(str(n)), unit=_unit_var(unit)))
    if target == "bigquery" and unit in ("HOUR", "MINUTE", "SECOND"):
        issues.append(issue("BigQuery DATE_ADD only accepts DATE: sub-day units use TIMESTAMP_ADD (TIMESTAMP columns; use DATETIME_ADD for DATETIME).", "warning"))
        return _fn("TIMESTAMP_ADD", date, exp.Interval(this=amount, unit=_unit_var(unit)))
    return None


# ---------------------------------------------------------------- DATEDIFF

def _date_diff(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    if target not in ("sqlite", "oracle", "mysql", "mariadb", "bigquery", "tsql", "hive", "clickhouse", "postgres", "redshift"):
        return
    for node in list(statement.find_all(exp.TimestampDiff, exp.DatetimeDiff)):
        if target in ("tsql", "hive", "clickhouse", "sqlite", "oracle", "postgres", "redshift"):  # MySQL's TIMESTAMPDIFF(unit, a, b) is printed as TIMESTAMPDIFF(b, a, unit) by these generators
            node.replace(exp.DateDiff(this=node.this.copy(), expression=node.expression.copy(), unit=node.args.get("unit")))
    for node in list(statement.find_all(exp.DateDiff)):
        unit_node = node.args.get("unit")
        unit = _unit(unit_node) if unit_node is not None else "DAY"
        if unit is None:
            continue
        end, start = _bare(node.this.copy()), _bare(node.expression.copy())
        replacement: exp.Expression | None = None
        if target == "oracle":
            replacement = _oracle_date_diff(end, start, unit, issues)
        elif target in ("mysql", "mariadb"):
            if unit == "DAY":
                replacement = _fn("DATEDIFF", end, start)
            else:
                replacement = _fn("TIMESTAMPDIFF", _unit_var(unit), start, end)
                issues.append(issue("MySQL TIMESTAMPDIFF counts complete units elapsed; T-SQL/Snowflake DATEDIFF count unit boundaries crossed, so results can differ by one.", "warning"))
        elif target == "bigquery":
            as_datetime = lambda x: x if isinstance(x, exp.Cast) and x.to.is_type("datetime") else exp.Cast(this=x, to=exp.DataType.build("datetime"))  # noqa: E731
            replacement = _fn("DATETIME_DIFF", as_datetime(end), as_datetime(start), _unit_var(unit))
        elif target == "sqlite" and unit == "DAY":
            julian = lambda x: _fn("JULIANDAY", _fn("DATE", x))  # noqa: E731
            replacement = exp.Cast(this=exp.Sub(this=julian(end), expression=julian(start)), to=exp.DataType.build("integer"))
        elif node.args.get("unit") is None:
            node.set("unit", _unit_var("DAY"))
        elif target in ("hive", "tsql", "clickhouse", "postgres", "redshift") and end is not node.this:
            node.set("this", end)
            node.set("expression", start)
        if replacement is not None:
            node.replace(replacement)


def _oracle_date_diff(end: exp.Expression, start: exp.Expression, unit: str, issues: list[Issue]) -> exp.Expression | None:
    as_date = lambda x: exp.Cast(this=x.copy(), to=exp.DataType.build("date"))  # noqa: E731
    if unit == "DAY":
        return exp.Paren(this=exp.Sub(this=_fn("TRUNC", as_date(end)), expression=_fn("TRUNC", as_date(start))))
    year = lambda x: exp.Extract(this=_unit_var("YEAR"), expression=as_date(x))  # noqa: E731
    month = lambda x: exp.Extract(this=_unit_var("MONTH"), expression=as_date(x))  # noqa: E731
    if unit == "YEAR":
        return exp.Paren(this=exp.Sub(this=year(end), expression=year(start)))
    if unit == "MONTH":
        return exp.Paren(this=exp.Add(this=exp.Mul(this=exp.Paren(this=exp.Sub(this=year(end), expression=year(start))), expression=exp.Literal.number(12)), expression=exp.Sub(this=month(end), expression=month(start))))
    issues.append(issue(f"Oracle has no DATEDIFF: only DAY, MONTH and YEAR differences are rewritten; for {unit.lower()}s subtract the DATEs ((end - start) * 24 gives hours) or use EXTRACT on an INTERVAL.", "error"))
    return None


# ---------------------------------------------------------------- DATE_TRUNC

_SQLITE_TRUNC = {"YEAR": "%Y-01-01", "MONTH": "%Y-%m-01", "HOUR": "%Y-%m-%d %H:00:00", "MINUTE": "%Y-%m-%d %H:%M:00", "SECOND": "%Y-%m-%d %H:%M:%S"}
_ORACLE_TRUNC = {"YEAR": "YEAR", "QUARTER": "Q", "MONTH": "MONTH", "WEEK": "IW", "DAY": "DD", "HOUR": "HH", "MINUTE": "MI"}
_TSQL_TRUNC = ("YEAR", "QUARTER", "MONTH", "DAY", "HOUR", "MINUTE")


def _date_trunc(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    if target not in ("sqlite", "oracle", "tsql", "hive"):
        return
    for node in list(statement.find_all(exp.TimestampTrunc, exp.DateTrunc, exp.DatetimeTrunc)):
        unit = _unit(node.args.get("unit"))
        value = node.this.copy()
        if unit is None:
            continue
        replacement: exp.Expression | None = None
        if target == "sqlite":
            if unit == "DAY":
                replacement = _fn("DATE", value)
            elif unit in _SQLITE_TRUNC:
                replacement = _fn("STRFTIME", exp.Literal.string(_SQLITE_TRUNC[unit]), value)
            else:
                issues.append(issue(f"SQLite has no DATE_TRUNC: {unit.lower()} truncation has no STRFTIME equivalent (year, month, day, hour, minute, second are rewritten).", "error"))
        elif target == "oracle":
            if unit in _ORACLE_TRUNC:
                replacement = _fn("TRUNC", value, exp.Literal.string(_ORACLE_TRUNC[unit]))
            else:
                issues.append(issue("Oracle TRUNC(date, fmt) cannot truncate to whole seconds: cast to TIMESTAMP and use CAST(... AS TIMESTAMP(0)).", "error"))
        elif target == "tsql":
            if unit in _TSQL_TRUNC:
                u = _unit_var(unit)
                replacement = _fn("DATEADD", u, _fn("DATEDIFF", u.copy(), exp.Literal.number(0), value), exp.Literal.number(0))  # works on every SQL Server version; DATETRUNC needs 2022
            else:
                issues.append(issue(f"T-SQL DATETRUNC({unit}) needs SQL Server 2022+ (the {unit.lower()} start also depends on SET DATEFIRST); older versions have no equivalent for it.", "warning"))
        elif target == "hive" and unit not in ("YEAR", "MONTH"):
            issues.append(issue(f"Hive TRUNC(date, fmt) only knows YEAR and MONTH: {unit.lower()} truncation is not available (use date_format + cast).", "error"))
        if replacement is not None:
            if node is statement:
                raise AssertionError("DATE_TRUNC cannot be a statement")
            node.replace(replacement)


# ---------------------------------------------------------------- EXTRACT

_SQLITE_EXTRACT = {"YEAR": "%Y", "MONTH": "%m", "DAY": "%d", "HOUR": "%H", "MINUTE": "%M", "SECOND": "%S", "DOW": "%w", "DOY": "%j", "EPOCH": "%s"}


def _extract(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    if target not in ("sqlite", "mysql", "mariadb", "tsql", "oracle", "bigquery", "clickhouse", "hive"):
        return
    for node in list(statement.find_all(exp.Extract)):
        part = node.this.name.upper() if isinstance(node.this, (exp.Var, exp.Identifier, exp.Column, exp.Literal)) else ""
        value = node.expression.copy()
        replacement: exp.Expression | None = None
        if target == "sqlite":
            if part in _SQLITE_EXTRACT:
                replacement = exp.Cast(this=_fn("STRFTIME", exp.Literal.string(_SQLITE_EXTRACT[part]), value), to=exp.DataType.build("integer"))
            elif part == "QUARTER":
                month = exp.Cast(this=_fn("STRFTIME", exp.Literal.string("%m"), value), to=exp.DataType.build("integer"))
                replacement = exp.Paren(this=exp.Div(this=exp.Paren(this=exp.Add(this=month, expression=exp.Literal.number(2))), expression=exp.Literal.number(3), typed=True))  # typed: integer division, no CAST AS REAL
            else:
                issues.append(issue(f"SQLite has no EXTRACT: {part or 'this part'} has no STRFTIME equivalent (year, month, day, hour, minute, second, dow, doy, epoch, quarter are rewritten).", "error"))
        elif target in ("mysql", "mariadb"):
            if part == "DOW":
                replacement = exp.Paren(this=exp.Sub(this=_fn("DAYOFWEEK", value), expression=exp.Literal.number(1)))  # MySQL: Sunday = 1, PostgreSQL dow: Sunday = 0
            elif part == "DOY":
                replacement = _fn("DAYOFYEAR", value)
            elif part == "EPOCH":
                replacement = _fn("UNIX_TIMESTAMP", value)
        elif target == "tsql":
            if part == "DOW":
                replacement = exp.Paren(this=exp.Sub(this=_fn("DATEPART", exp.Var(this="WEEKDAY"), value), expression=exp.Literal.number(1)))
                issues.append(issue("T-SQL weekday numbering follows SET DATEFIRST (default 7: Sunday = 1): the rewrite assumes the default so Sunday = 0 as in PostgreSQL.", "warning"))
            elif part == "DOY":
                replacement = _fn("DATEPART", exp.Var(this="DAYOFYEAR"), value)
            elif part == "EPOCH":
                replacement = _fn("DATEDIFF_BIG", exp.Var(this="SECOND"), exp.Literal.string("1970-01-01"), value)
        elif target == "oracle":
            if part == "QUARTER":
                replacement = _fn("CEIL", exp.Div(this=exp.Extract(this=exp.Var(this="MONTH"), expression=value), expression=exp.Literal.number(3)))
            elif part == "DOY":
                replacement = _fn("TO_NUMBER", _fn("TO_CHAR", value, exp.Literal.string("DDD")))
            elif part in ("DOW", "EPOCH", "WEEK"):
                issues.append(issue(f"Oracle EXTRACT only knows year, month, day, hour, minute, second and time zone parts: {part.lower()} is not available (TO_CHAR(date, 'D') depends on NLS_TERRITORY).", "error"))
        elif target == "bigquery":
            if part == "DOW":
                replacement = exp.Paren(this=exp.Sub(this=exp.Extract(this=exp.Var(this="DAYOFWEEK"), expression=value), expression=exp.Literal.number(1)))
            elif part == "DOY":
                replacement = exp.Extract(this=exp.Var(this="DAYOFYEAR"), expression=value)
            elif part == "EPOCH":
                replacement = _fn("UNIX_SECONDS", _fn("TIMESTAMP", value))
        elif target == "clickhouse":
            if part == "DOW":
                replacement = exp.Paren(this=exp.Mod(this=_fn("toDayOfWeek", value), expression=exp.Literal.number(7)))
            elif part == "DOY":
                replacement = _fn("toDayOfYear", value)
            elif part == "EPOCH":
                replacement = _fn("toUnixTimestamp", value)
        elif target == "hive":
            if part == "EPOCH":
                replacement = _fn("UNIX_TIMESTAMP", value)
            elif part in ("DOW", "DOY"):
                issues.append(issue(f"Hive EXTRACT only knows year, quarter, month, week, day, hour, minute, second: {part.lower()} is not available (date_format(d, 'u') gives the ISO weekday).", "error"))
        if replacement is not None:
            node.replace(replacement)


# ---------------------------------------------------------------- string aggregation

def _string_agg(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    if target not in ("redshift", "hive", "spark", "clickhouse", "sqlite"):
        return
    for node in list(statement.find_all(exp.GroupConcat)):
        this = node.this
        order = this if isinstance(this, exp.Order) else None
        value = (order.this if order is not None else this).copy()
        separator = node.args.get("separator")
        separator = separator.copy() if separator is not None else exp.Literal.string(",")
        if target == "redshift":
            if order is not None:
                inner = exp.GroupConcat(this=value, separator=separator)
                node.replace(exp.WithinGroup(this=inner, expression=exp.Order(expressions=[o.copy() for o in order.expressions])))
        elif target in ("hive", "spark"):
            collected: exp.Expression = _fn("COLLECT_LIST", value)
            if order is not None:
                keys = order.expressions
                if len(keys) == 1 and keys[0].this.sql() == value.sql() and not keys[0].args.get("desc"):
                    collected = _fn("SORT_ARRAY", collected)
                else:
                    issues.append(issue(f"{target} has no ordered string aggregation before Spark 4 (LISTAGG): the ORDER BY inside STRING_AGG is dropped, so the order of the joined values is not defined. Sort in a subquery or use SORT_ARRAY(COLLECT_LIST(...)) for ascending order of the value itself.", "warning"))
            node.replace(_fn("CONCAT_WS", separator, collected))
        elif target == "clickhouse":
            if order is not None:
                issues.append(issue("ClickHouse arrayStringConcat(groupArray(x), sep) has no ORDER BY: the order of the joined values is not defined (wrap arraySort(...) around groupArray for ascending order).", "warning"))
            node.replace(_fn("arrayStringConcat", _fn("groupArray", value.copy()), separator))
        elif target == "sqlite" and order is not None:
            issues.append(issue("SQLite supports ORDER BY inside GROUP_CONCAT only from version 3.44 (and not NULLS FIRST/LAST there).", "warning"))


# ---------------------------------------------------------------- text / misc functions

_NULL_IGNORING = {"postgres", "redshift", "spark"}
_NULL_PROPAGATING = {"mysql", "mariadb", "oracle", "bigquery", "trino", "hive"}


def _text_functions(statement: exp.Expression, source: str, target: str, issues: list[Issue]) -> None:
    if target == "sqlite":
        for node in list(statement.find_all(exp.Left)):
            node.replace(_fn("SUBSTR", node.this.copy(), exp.Literal.number(1), node.expression.copy()))
        for node in list(statement.find_all(exp.Right)):
            count = node.expression.copy()
            n = _int(count)
            start: exp.Expression = _num(-n) if n is not None and n > 0 else _fn("MAX", exp.Add(this=exp.Sub(this=_fn("LENGTH", node.this.copy()), expression=exp.Paren(this=count) if isinstance(count, exp.Binary) else count), expression=exp.Literal.number(1)), exp.Literal.number(1))
            node.replace(_fn("SUBSTR", node.this.copy(), start))
        if any(True for _ in statement.find_all(exp.RegexpLike)):
            issues.append(issue("SQLite has no REGEXP function unless the application registers one: `x REGEXP 'p'` fails with 'no such function: REGEXP'. Use LIKE/GLOB or load a regexp extension.", "error"))
    if target == "oracle":
        for node in list(statement.find_all(exp.Concat)):  # Oracle CONCAT takes exactly two arguments
            parts = [p.copy() for p in node.expressions]
            if len(parts) > 2:
                chained = parts[0]
                for part in parts[1:]:
                    chained = exp.DPipe(this=chained, expression=part)
                node.replace(chained)
    if target == "tsql":
        for node in list(statement.find_all(exp.Trim)):  # TRIM(BOTH ...) is SQL Server 2022; the default position needs no keyword
            if str(node.args.get("position") or "").upper() == "BOTH":
                node.set("position", None)
            elif node.args.get("position"):
                issues.append(issue("T-SQL TRIM(LEADING/TRAILING ...) needs SQL Server 2022; before that use LTRIM/RTRIM.", "warning"))
        if any(True for _ in statement.find_all(exp.Pad)):
            issues.append(issue("T-SQL has no LPAD/RPAD: use RIGHT(REPLICATE('0', n) + CAST(x AS VARCHAR(n)), n) for left padding (it truncates from the left, LPAD truncates from the right).", "error"))
        if any(True for _ in statement.find_all(exp.RegexpReplace, exp.RegexpLike, exp.RegexpExtract)):
            issues.append(issue("T-SQL has no regular-expression functions before SQL Server 2025 (REGEXP_LIKE/REGEXP_REPLACE): use LIKE/PATINDEX or a CLR function.", "error"))
    if target in ("mysql", "mariadb", "oracle", "tsql", "hive"):
        for node in list(statement.find_all(exp.SplitPart)):
            index = _int(node.args.get("part_index"))
            delimiter = node.args.get("delimiter")
            if target in ("mysql", "mariadb") and index is not None and index > 0 and isinstance(delimiter, exp.Literal):
                first = _fn("SUBSTRING_INDEX", node.this.copy(), delimiter.copy(), exp.Literal.number(index))
                node.replace(_fn("SUBSTRING_INDEX", first, delimiter.copy(), exp.Literal.number(-1)))
                issues.append(issue("SPLIT_PART became SUBSTRING_INDEX(SUBSTRING_INDEX(s, d, n), d, -1): when s has fewer than n parts it returns the last part, SPLIT_PART returns an empty string.", "warning"))
            else:
                if target == "tsql":
                    node.replace(_fn("SPLIT_PART", node.this.copy(), node.args["delimiter"].copy(), node.args["part_index"].copy()))  # keep it visible: sqlglot would drop the column
                issues.append(issue(f"{target} has no SPLIT_PART: split with " + {"oracle": "REGEXP_SUBSTR(s, '[^,]+', 1, n)", "hive": "SPLIT(s, regex)[n - 1]", "tsql": "STRING_SPLIT(s, d, 1) (SQL Server 2022) or PARSENAME for '.'"}.get(target, "SUBSTRING_INDEX") + " instead.", "error"))
    if source in _NULL_IGNORING and target in _NULL_PROPAGATING and any(True for _ in statement.find_all(exp.Greatest, exp.Least)):
        issues.append(issue(f"GREATEST/LEAST ignore NULL arguments in {source} but return NULL when any argument is NULL in {target}: wrap the arguments in COALESCE if NULLs are possible.", "warning"))


# ---------------------------------------------------------------- TRUNCATE

def _truncate(statement: exp.Expression, target: str, issues: list[Issue]) -> exp.Expression:
    if target == "sqlite" and isinstance(statement, exp.TruncateTable) and len(statement.expressions) == 1:
        issues.append(issue("SQLite has no TRUNCATE: converted to DELETE FROM (it does not reset AUTOINCREMENT counters; delete the sqlite_sequence row for that).", "warning"))
        return exp.Delete(this=statement.expressions[0].copy())
    return statement


# ---------------------------------------------------------------- DDL

def _ddl(statement: exp.Expression, source: str, target: str, issues: list[Issue]) -> None:
    if isinstance(statement, exp.Create) and str(statement.args.get("kind")).upper() == "INDEX":
        _index_nulls(statement, source, target, issues)
        if target in ("snowflake", "redshift", "bigquery", "trino", "spark", "hive", "clickhouse"):
            issues.append(issue(f"{target} has no CREATE INDEX" + {"snowflake": " (only hybrid tables; use clustering keys)", "redshift": " (use SORTKEY/DISTKEY)", "bigquery": " (only search/vector indexes; use partitioning/clustering)", "trino": " (storage-connector specific)", "spark": " (use Delta Z-ORDER / bloom filters)", "hive": " (indexes were removed in Hive 3)", "clickhouse": " (data-skipping indexes are ALTER TABLE ... ADD INDEX ... TYPE ... GRANULARITY n)"}[target] + ".", "error"))
        if statement.args.get("exists") and target in ("mysql", "oracle"):
            issues.append(issue(f"{target} has no CREATE INDEX IF NOT EXISTS" + (" (MariaDB and Oracle 23ai do)." if target == "mysql" else " before 23ai."), "error" if target == "mysql" else "warning"))
    if isinstance(statement, exp.Alter):
        for action in statement.args.get("actions") or []:
            if isinstance(action, exp.ColumnDef) and action.args.get("exists") and target in ("sqlite", "mysql", "tsql", "oracle"):
                issues.append(issue(f"{target} has no ADD COLUMN IF NOT EXISTS" + (" (MariaDB does)" if target == "mysql" else "") + ": check the catalog first or let the statement fail when the column exists.", "error"))
    if isinstance(statement, exp.Drop) and statement.args.get("exists") and target == "oracle":
        issues.append(issue("Oracle accepts DROP ... IF EXISTS only from 23ai.", "warning"))
    for definition in list(statement.find_all(exp.ColumnDef)):
        _boolean_default(definition, target)
        _uuid_column(definition, target, issues)
        if target == "oracle":
            _default_first(definition)
    if isinstance(statement, exp.Create) and str(statement.args.get("kind")).upper() == "TABLE":
        if target == "clickhouse":
            _clickhouse_engine(statement, issues)
        elif target in ("bigquery", "trino", "spark", "hive") and any(True for _ in statement.find_all(exp.PrimaryKeyColumnConstraint, exp.PrimaryKey)):
            issues.append(issue(f"{target}: PRIMARY KEY is " + {"bigquery": "only accepted as a table constraint written PRIMARY KEY (cols) NOT ENFORCED", "trino": "not supported in CREATE TABLE by most connectors", "spark": "not enforced and rejected outside Databricks/Delta", "hive": "informational only (DISABLE NOVALIDATE required)"}[target] + ".", "warning"))


def _index_nulls(statement: exp.Create, source: str, target: str, issues: list[Issue]) -> None:
    """sqlglot reads `ON t (a)` as `a NULLS LAST` and emulates it with CASE WHEN a IS NULL ... inside the index (invalid in T-SQL/MySQL) or prints NULLS LAST (invalid in SQLite/Oracle indexes)."""
    src_order = sqlglot.Dialect.get_or_raise(sg_name(source)).NULL_ORDERING
    tgt_order = sqlglot.Dialect.get_or_raise(sg_name(target)).NULL_ORDERING

    def default(order: str, desc: bool) -> bool:
        return False if order == "nulls_are_last" else ((order == "nulls_are_small") != desc)

    for ordered in list(statement.find_all(exp.Ordered)):
        desc = bool(ordered.args.get("desc"))
        explicit_other = ordered.args.get("nulls_first") is not None and ordered.args.get("nulls_first") != default(src_order, desc)
        if explicit_other and target in ("postgres", "duckdb"):
            continue
        if explicit_other:
            issues.append(issue(f"{target} cannot order NULLs inside an index definition: NULLS FIRST/LAST was dropped.", "warning"))
        ordered.set("nulls_first", default(tgt_order, desc))  # the target's own default: prints nothing and emulates nothing


def _default_first(definition: exp.ColumnDef) -> None:
    """Oracle: `col NUMBER(1) DEFAULT 0 NOT NULL` -- DEFAULT (or the identity clause) must precede the inline constraints (ORA-00907 otherwise)."""
    constraints = list(definition.args.get("constraints") or [])
    ordered = sorted(constraints, key=lambda c: 0 if isinstance(c.args.get("kind"), (exp.DefaultColumnConstraint, exp.GeneratedAsIdentityColumnConstraint)) else 1)
    if ordered != constraints:
        definition.set("constraints", ordered)


def _boolean_default(definition: exp.ColumnDef, target: str) -> None:
    if target not in ("tsql", "oracle"):
        return
    for constraint in definition.args.get("constraints") or []:
        kind = constraint.args.get("kind")
        if isinstance(kind, exp.DefaultColumnConstraint):
            value = kind.this.this if isinstance(kind.this, exp.Paren) else kind.this
            flag = value.this if isinstance(value, exp.Boolean) else None
            if isinstance(value, exp.EQ) and isinstance(value.this, exp.Literal) and isinstance(value.expression, exp.Literal) and value.this.this == value.expression.this:
                flag = True  # sqlglot's own (1 = 1) stand-in for TRUE
            if flag is not None:
                kind.set("this", exp.Literal.number(1 if flag else 0))


def _uuid_column(definition: exp.ColumnDef, target: str, issues: list[Issue]) -> None:
    dtype = definition.args.get("kind")
    if not isinstance(dtype, exp.DataType):
        return
    for node in list(definition.find_all(exp.Uuid)):
        if target == "oracle":
            node.replace(_fn("SYS_GUID"))
        elif target == "clickhouse":
            node.replace(_fn("generateUUIDv4"))
        elif target == "redshift":
            issues.append(issue("Redshift has no UUID generator function (GEN_RANDOM_UUID does not exist): fill the column from the application.", "error"))
        elif target in ("mysql", "mariadb"):
            parent = node.parent
            if isinstance(parent, exp.DefaultColumnConstraint):
                parent.set("this", exp.Paren(this=node.copy()))  # MySQL 8.0.13+: a function default must be an expression in parentheses
    if dtype.this != exp.DType.UUID:
        return
    replacements = {
        "mysql": ("char(36)", "MySQL has no UUID type: CHAR(36) holds the text form."),
        "mariadb": ("char(36)", "MariaDB's UUID type needs 10.7+: CHAR(36) holds the text form everywhere."),
        "snowflake": ("varchar(36)", "Snowflake has no UUID type: VARCHAR(36) holds the text form (UUID_STRING())."),
        "redshift": ("varchar(36)", "Redshift has no UUID type: VARCHAR(36) holds the text form."),
        "hive": ("string", "Hive has no UUID type: STRING holds the text form."),
        "oracle": ("RAW(16)", "Oracle has no UUID type: RAW(16) holds SYS_GUID() values."),
    }
    if target in replacements:
        text, why = replacements[target]
        definition.set("kind", exp.DataType(this=exp.DType.USERDEFINED, kind=text) if target == "oracle" else exp.DataType.build(text))
        issues.append(issue(f"Column '{definition.name}': {why}", "warning"))


def _clickhouse_engine(statement: exp.Create, issues: list[Issue]) -> None:
    """ClickHouse tables need an ENGINE; key columns cannot be Nullable (sqlglot wraps every type in Nullable() unless told otherwise)."""
    properties = statement.args.get("properties")
    names = {type(p).__name__ for p in (properties.expressions if properties else [])}
    keys: list[str] = []
    for definition in statement.find_all(exp.ColumnDef):
        pk = any(isinstance(c.args.get("kind"), exp.PrimaryKeyColumnConstraint) for c in definition.args.get("constraints") or [])
        if pk:
            keys.append(definition.name)
        dtype = definition.args.get("kind")
        not_null = any(isinstance(c.args.get("kind"), exp.NotNullColumnConstraint) for c in definition.args.get("constraints") or [])
        if isinstance(dtype, exp.DataType) and (pk or not_null):
            dtype.set("nullable", False)
        definition.set("constraints", [c for c in definition.args.get("constraints") or [] if not isinstance(c.args.get("kind"), (exp.PrimaryKeyColumnConstraint, exp.NotNullColumnConstraint))] or None)
    if "EngineProperty" not in names:
        order = exp.Order(expressions=[exp.Ordered(this=exp.column(keys[0]) if len(keys) == 1 else exp.Tuple(expressions=[exp.column(k) for k in keys]))]) if keys else exp.var("ORDER BY tuple()")
        statement.set("properties", exp.Properties(expressions=[*(properties.expressions if properties else []), exp.EngineProperty(this=exp.var("MergeTree")), order]))
        issues.append(issue("ClickHouse requires an ENGINE: MergeTree was added" + (" with the primary key columns as sorting key." if keys else " (ORDER BY tuple()).") + " Key and NOT NULL columns are plain types (no Nullable).", "warning"))


# ---------------------------------------------------------------- FETCH FIRST ... WITH TIES / TOP ... WITH TIES

_WITH_TIES_TARGETS = {"tsql", "postgres", "oracle", "trino", "clickhouse"}


def _row_limits(statement: exp.Expression, target: str, issues: list[Issue]) -> None:
    for select in list(statement.find_all(exp.Select)):
        limit = select.args.get("limit")
        options = limit.args.get("limit_options") if limit is not None else None
        if options is None or not options.args.get("with_ties"):
            continue
        count = limit.args.get("expression") if isinstance(limit, exp.Limit) else limit.args.get("count")
        if target not in _WITH_TIES_TARGETS:
            issues.append(issue(f"{target} has no WITH TIES: rows tied with the last row would be dropped. Rank in a subquery instead (RANK() OVER (ORDER BY ...) <= n).", "error"))
            continue
        if target == "clickhouse" and isinstance(limit, exp.Fetch):
            select.set("limit", exp.Limit(expression=count.copy(), limit_options=exp.LimitOptions(percent=False, rows=False, with_ties=True)))
        elif target in ("postgres", "oracle", "trino") and isinstance(limit, exp.Limit):
            select.set("limit", exp.Fetch(direction="FIRST", count=count.copy(), limit_options=exp.LimitOptions(percent=False, rows=True, with_ties=True)))
        elif target == "tsql" and isinstance(limit, exp.Fetch):
            select.set("limit", exp.Limit(expression=count.copy(), limit_options=exp.LimitOptions(percent=False, rows=False, with_ties=True)))
            issues.append(issue("T-SQL supports WITH TIES only in TOP (n) WITH TIES, which needs an ORDER BY and cannot be combined with OFFSET.", "warning"))
