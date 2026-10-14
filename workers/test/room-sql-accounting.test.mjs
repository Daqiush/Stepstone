import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountedRows,
  createSqlProfileRecorder,
  emptySqlAccounting,
  executeAccountedSql,
} from '../src/room-foundation/sql-accounting.mjs';

function lazySql({ rows, rowsRead, rowsWritten }) {
  return {
    exec() {
      return {
        rowsRead: 0,
        rowsWritten: 0,
        toArray() {
          this.rowsRead = rowsRead;
          this.rowsWritten = rowsWritten;
          return rows;
        },
      };
    },
  };
}

test('records lazy SELECT cursor metrics only after consuming its rows', () => {
  const accounting = emptySqlAccounting();
  const result = accountedRows(
    lazySql({ rows: [{ revision: 3 }], rowsRead: 1, rowsWritten: 0 }),
    accounting,
    'SELECT * FROM room_state LIMIT 1',
  );

  assert.deepEqual(result, [{ revision: 3 }]);
  assert.equal(accounting.totalRowsRead, 1);
  assert.equal(accounting.roomStateRowsRead, 1);
  assert.deepEqual(accounting.statements, [{
    operation: 'SELECT', table: 'room_state', rowsRead: 1, rowsWritten: 0,
  }]);
});

test('records lazy UPDATE metrics only after consuming its cursor', () => {
  const accounting = emptySqlAccounting();
  const cursor = executeAccountedSql(
    lazySql({ rows: [], rowsRead: 1, rowsWritten: 1 }),
    accounting,
    'UPDATE room_state SET revision = 1',
  );

  assert.equal(cursor.rowsWritten, 1);
  assert.equal(accounting.totalRowsRead, 1);
  assert.equal(accounting.totalRowsWritten, 1);
  assert.equal(accounting.roomStateRowsWritten, 1);
});

test('profile recorder consumes each cursor once and returns cached rows to callers', () => {
  let consumptions = 0;
  const raw = {
    exec(statement) {
      return {
        rowsRead: 0,
        rowsWritten: 0,
        toArray() {
          consumptions += 1;
          this.rowsRead = statement.startsWith('SELECT') ? 7 : 1;
          this.rowsWritten = statement.startsWith('UPDATE') ? 1 : 0;
          return [{ value: 1 }];
        },
      };
    },
  };
  const recorder = createSqlProfileRecorder(raw);

  recorder.reset();
  const select = recorder.sql.exec('SELECT * FROM room_codes');
  assert.deepEqual(select.toArray(), [{ value: 1 }]);
  assert.deepEqual(select.toArray(), [{ value: 1 }]);
  const update = recorder.sql.exec('UPDATE room_codes SET status = 1');

  assert.equal(consumptions, 2);
  assert.equal(select.rowsRead, 7);
  assert.equal(update.rowsWritten, 1);
  assert.deepEqual(recorder.snapshot(), {
    statements: [
      { operation: 'SELECT', table: 'room_codes', rowsRead: 7, rowsWritten: 0 },
      { operation: 'UPDATE', table: 'room_codes', rowsRead: 1, rowsWritten: 1 },
    ],
    totalRowsRead: 8,
    totalRowsWritten: 1,
  });
});
