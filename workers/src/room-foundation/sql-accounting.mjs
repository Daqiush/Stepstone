export function emptySqlAccounting() {
  return {
    statements: [],
    totalRowsRead: 0,
    totalRowsWritten: 0,
    roomStateRowsRead: 0,
    roomStateRowsWritten: 0,
    sessionRowsRead: 0,
    sessionRowsWritten: 0,
    actionRowsRead: 0,
    actionRowsWritten: 0,
  };
}

function sqlTable(statement) {
  const normalized = statement.toLowerCase();
  if (/\broom_state\b/u.test(normalized)) return 'room_state';
  if (/\bsessions\b/u.test(normalized)) return 'sessions';
  if (/\bpending_actions\b/u.test(normalized)) return 'pending_actions';
  if (/\broom_codes\b/u.test(normalized)) return 'room_codes';
  if (/\bcreation_requests\b/u.test(normalized)) return 'creation_requests';
  return 'other';
}

function recordSql(accounting, statement, cursor) {
  const operation = statement.trimStart().split(/\s+/u, 1)[0].toUpperCase();
  const table = sqlTable(statement);
  const rowsRead = Number.isSafeInteger(cursor.rowsRead) ? cursor.rowsRead : 0;
  const rowsWritten = Number.isSafeInteger(cursor.rowsWritten) ? cursor.rowsWritten : 0;
  accounting.statements.push({ operation, table, rowsRead, rowsWritten });
  accounting.totalRowsRead += rowsRead;
  accounting.totalRowsWritten += rowsWritten;
  const prefix = table === 'room_state' ? 'roomState'
    : table === 'sessions' ? 'session'
      : table === 'pending_actions' ? 'action' : null;
  if (prefix !== null) {
    accounting[`${prefix}RowsRead`] += rowsRead;
    accounting[`${prefix}RowsWritten`] += rowsWritten;
  }
}

export function executeAccountedSql(sql, accounting, statement, ...bindings) {
  const cursor = sql.exec(statement, ...bindings);
  cursor.toArray();
  recordSql(accounting, statement, cursor);
  return cursor;
}

export function accountedRows(sql, accounting, statement, ...bindings) {
  const cursor = sql.exec(statement, ...bindings);
  const result = cursor.toArray();
  recordSql(accounting, statement, cursor);
  return result;
}

export function accountedRow(sql, accounting, statement, ...bindings) {
  return accountedRows(sql, accounting, statement, ...bindings)[0] ?? null;
}

export function addSqlAccounting(target, source) {
  for (const key of [
    'totalRowsRead', 'totalRowsWritten',
    'roomStateRowsRead', 'roomStateRowsWritten',
    'sessionRowsRead', 'sessionRowsWritten',
    'actionRowsRead', 'actionRowsWritten',
  ]) target[key] += source[key];
}

export function createSqlProfileRecorder(rawSql) {
  let statements = [];
  const sql = {
    exec(statement, ...bindings) {
      const cursor = rawSql.exec(statement, ...bindings);
      const cachedRows = cursor.toArray();
      const rowsRead = Number.isSafeInteger(cursor.rowsRead) ? cursor.rowsRead : 0;
      const rowsWritten = Number.isSafeInteger(cursor.rowsWritten) ? cursor.rowsWritten : 0;
      statements.push({
        operation: statement.trimStart().split(/\s+/u, 1)[0].toUpperCase(),
        table: sqlTable(statement),
        rowsRead,
        rowsWritten,
      });
      return Object.freeze({
        rowsRead,
        rowsWritten,
        toArray: () => [...cachedRows],
      });
    },
  };
  return Object.freeze({
    sql,
    reset() { statements = []; },
    snapshot() {
      const copied = statements.map((statement) => ({ ...statement }));
      return {
        statements: copied,
        totalRowsRead: copied.reduce((sum, statement) => sum + statement.rowsRead, 0),
        totalRowsWritten: copied.reduce((sum, statement) => sum + statement.rowsWritten, 0),
      };
    },
  });
}
