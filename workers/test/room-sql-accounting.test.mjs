import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountedRows,
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
