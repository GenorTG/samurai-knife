"""Shared helpers: dialect ids, parsing with positioned issues, generation with unsupported-feature capture."""
from __future__ import annotations

import re
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.errors import ErrorLevel, ParseError, SqlglotError, TokenError
from sqlglot.tokens import TokenType

# Public dialect ids (src/lib/sql/types.ts SQL_DIALECTS). MariaDB has no sqlglot dialect: it compiles as mysql.
DIALECT_IDS = (
    "sqlite", "postgres", "mysql", "mariadb", "tsql", "oracle", "bigquery", "snowflake",
    "duckdb", "redshift", "clickhouse", "trino", "spark", "hive",
)
_SQLGLOT_NAME = {"mariadb": "mysql"}

Issue = dict[str, Any]

_NOT_A_STATEMENT = (exp.Alias, exp.Column, exp.Literal, exp.Identifier, exp.Var, exp.Paren, exp.Binary, exp.Unary, exp.Func, exp.Star, exp.Boolean, exp.Null)


class SqlToolError(Exception):
    """Anything the caller can fix: becomes {"ok": false, "error": message}."""


def sg_name(dialect: str) -> str:
    return _SQLGLOT_NAME.get(dialect, dialect)


def need_dialect(params: dict[str, Any], key: str = "dialect") -> str:
    value = params.get(key)
    if not isinstance(value, str) or value not in DIALECT_IDS:
        raise SqlToolError(f"params.{key}: expected one of {', '.join(DIALECT_IDS)} (got {value!r}).")
    return value


def need_str(params: dict[str, Any], key: str, *, allow_empty: bool = False) -> str:
    value = params.get(key)
    if not isinstance(value, str):
        raise SqlToolError(f"params.{key}: expected a string.")
    if not allow_empty and not value.strip():
        raise SqlToolError(f"params.{key}: must not be empty.")
    return value


def issue(message: str, level: str = "error", line: int | None = None, column: int | None = None) -> Issue:
    out: Issue = {"message": message, "level": level}
    if line is not None:
        out["line"] = line
    if column is not None:
        out["column"] = column
    return out


def mariadb_note(dialect: str, what: str) -> Issue | None:
    return issue(f"MariaDB is compiled with the MySQL dialect: {what}", "warning") if dialect == "mariadb" else None


_TOKEN_REPR = re.compile(r"<Token token_type: [^,]*, text: (.*?), line: \d+, col: \d+, start: \d+, end: \d+, comments: \[.*?\]>")


class ParseFailure(Exception):
    def __init__(self, issues: list[Issue]):
        super().__init__("; ".join(i["message"] for i in issues))
        self.issues = issues


_REQUIRED_KEYWORD = re.compile(r"Required keyword: '(\w+)' missing for <class 'sqlglot\.expressions\.(?:\w+\.)?(\w+)'>")


_OPERATORS = {"Add": "+", "Sub": "-", "Mul": "*", "Div": "/", "Mod": "%", "EQ": "=", "NEQ": "<>", "GT": ">", "GTE": ">=", "LT": "<", "LTE": "<=", "And": "AND", "Or": "OR", "Like": "LIKE", "ILike": "ILIKE", "DPipe": "||"}


def _plain_message(text: str) -> str:
    """sqlglot's internals ('Required keyword: 'this' missing for <class ...Where>', the 'SENTINEL' end marker) say nothing to a user (or a model)."""
    text = text.replace("'SENTINEL'", "the end of the statement")
    match = _REQUIRED_KEYWORD.search(text)
    if match is None:
        return text
    name = match.group(2)
    if name in _OPERATORS:
        return f"The '{_OPERATORS[name]}' operator is missing an operand."
    clause = re.sub(r"(?<!^)(?=[A-Z])", " ", name).upper()
    return f"{clause} is incomplete: it needs something after it (a condition, expression or name)."


def _issues_from_parse_error(error: ParseError) -> list[Issue]:
    out: list[Issue] = []
    for item in error.errors or []:
        text = _plain_message(_TOKEN_REPR.sub(lambda m: f"'{m.group(1)}'", str(item.get("description", "Syntax error"))))
        line, col = item.get("line"), item.get("col")
        highlight = item.get("highlight") or ""
        # sqlglot reports the END column of the offending token; convert to its first column.
        start = col - len(highlight) + 1 if isinstance(col, int) and highlight and "\n" not in highlight else col
        out.append(issue(text, "error", line if isinstance(line, int) else None, start if isinstance(start, int) and start > 0 else None))
    return out or [issue(str(error))]


def _tsql_delete_output_last(chunk: list[Any]) -> list[Any]:
    """T-SQL writes `DELETE FROM t OUTPUT deleted.x WHERE ...`; sqlglot only parses the clause after WHERE, so move it there."""
    if not chunk or chunk[0].token_type != TokenType.DELETE:
        return chunk
    depth = 0
    start = end = -1
    for i, token in enumerate(chunk):
        if token.token_type == TokenType.L_PAREN:
            depth += 1
        elif token.token_type == TokenType.R_PAREN:
            depth -= 1
        elif depth == 0 and start < 0 and token.token_type == TokenType.RETURNING and token.text.upper() == "OUTPUT":
            start = i
        elif depth == 0 and start >= 0 and token.token_type in (TokenType.WHERE, TokenType.FROM):
            end = i
            break
    if start < 0 or end < 0:
        return chunk
    return chunk[:start] + chunk[end:] + chunk[start:end]


def parse_statements(sql: str, dialect: str) -> list[exp.Expression]:
    """All non-empty statements of `sql`; raises ParseFailure with positioned issues for every bad statement."""
    dia = sqlglot.Dialect.get_or_raise(sg_name(dialect))
    try:
        tokens = dia.tokenize(sql)
    except TokenError as error:
        raise ParseFailure([issue(str(error).replace("Error tokenizing ", "Cannot tokenize: ", 1))]) from error
    except SqlglotError as error:
        raise ParseFailure([issue(str(error))]) from error
    chunks: list[list[Any]] = [[]]
    for token in tokens:
        if token.token_type == TokenType.SEMICOLON:
            chunks.append([])
        else:
            chunks[-1].append(token)
    statements: list[exp.Expression] = []
    issues: list[Issue] = []
    for chunk in chunks:
        if not chunk:
            continue
        try:
            if dialect == "tsql":
                chunk = _tsql_delete_output_last(chunk)
            parsed = [s for s in dia.parser(max_errors=50).parse(chunk, sql) if s is not None]
            if any(isinstance(s, _NOT_A_STATEMENT) for s in parsed):
                # sqlglot reads `SELEC x` as an aliased column; a lone expression is never a SQL statement.
                first = chunk[0]
                issues.append(issue(f"Not a SQL statement: unknown keyword '{first.text}'.", "error", first.line, max(1, first.col - len(first.text) + 1)))
                continue
            statements.extend(parsed)
        except ParseError as error:
            issues.extend(_issues_from_parse_error(error))
        except SqlglotError as error:
            issues.append(issue(str(error)))
    if issues:
        raise ParseFailure(issues)
    return statements


def generate(expression: exp.Expression, dialect: str, pretty: bool = False) -> tuple[str, list[str]]:
    """Render one statement; returns (sql, sqlglot's unsupported-construct messages)."""
    if dialect == "tsql" and isinstance(expression, exp.Delete) and expression.args.get("returning") is not None:
        return _tsql_delete_output(expression, dialect, pretty)
    return generate_plain(expression, dialect, pretty)


def _tsql_delete_output(expression: exp.Delete, dialect: str, pretty: bool) -> tuple[str, list[str]]:
    """sqlglot writes `DELETE OUTPUT x FROM t WHERE ...` for T-SQL, which SQL Server rejects; the clause belongs right after the target: `DELETE FROM t OUTPUT deleted.x WHERE ...`."""
    returning = expression.args["returning"]
    bare = expression.copy()
    bare.set("returning", None)
    generator = sqlglot.Dialect.get_or_raise(sg_name(dialect)).generator(pretty=pretty, unsupported_level=ErrorLevel.IGNORE)
    base = generator.generate(bare, copy=False)
    target = generator.generate(expression.this.copy(), copy=False) if expression.this is not None else ""
    output = sqlglot.Dialect.get_or_raise(sg_name(dialect)).generator(pretty=False).generate(returning.copy(), copy=False)
    head = f"DELETE FROM {target}"
    if not target or not base.startswith(head):
        return generate_plain(expression, dialect, pretty)
    return f"{head} {output}{base[len(head):]}", list(dict.fromkeys(generator.unsupported_messages))


def generate_plain(expression: exp.Expression, dialect: str, pretty: bool) -> tuple[str, list[str]]:
    """Render one statement exactly as sqlglot's generator does."""
    generator = sqlglot.Dialect.get_or_raise(sg_name(dialect)).generator(pretty=pretty, unsupported_level=ErrorLevel.IGNORE)
    sql = generator.generate(expression, copy=True)
    return sql, list(dict.fromkeys(generator.unsupported_messages))


def join_statements(statements: list[str], pretty: bool) -> str:
    """One statement: no trailing semicolon (driver friendly). Several: each ends with `;`."""
    if len(statements) == 1:
        return statements[0]
    return ("\n\n" if pretty else "\n").join(f"{s};" for s in statements)


def levenshtein(a: str, b: str) -> int:
    """Edit distance (insert/delete/substitute, adjacent transposition counts 1: 'emial' -> 'email')."""
    a, b = a.lower(), b.lower()
    rows = [list(range(len(b) + 1))]
    for i, ca in enumerate(a, 1):
        row = [i]
        for j, cb in enumerate(b, 1):
            best = min(rows[-1][j] + 1, row[j - 1] + 1, rows[-1][j - 1] + (ca != cb))
            if i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                best = min(best, rows[-2][j - 2] + 1)
            row.append(best)
        rows.append(row)
    return rows[-1][-1]


def suggest(name: str, candidates: list[str]) -> str | None:
    """Closest candidate by edit distance, or None when nothing is plausibly a typo of `name`."""
    best: tuple[int, str] | None = None
    for candidate in dict.fromkeys(candidates):
        distance = levenshtein(name, candidate)
        # Prefix / containment also counts ("user" vs "users", "created" vs "created_at").
        if name.lower() != candidate.lower() and (candidate.lower().startswith(name.lower()) or name.lower().startswith(candidate.lower())):
            distance = min(distance, 1)
        if best is None or distance < best[0]:
            best = (distance, candidate)
    if best is None:
        return None
    limit = max(1, min(3, len(name) // 3))
    return best[1] if best[0] <= limit else None


def did_you_mean(name: str, candidates: list[str]) -> str:
    guess = suggest(name, candidates)
    return f" Did you mean '{guess}'?" if guess else ""
