import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

function durableWrite(temp, content) {
  const fd = openSync(temp, 'wx');
  try { writeFileSync(fd, content); fsyncSync(fd); }
  finally { closeSync(fd); }
}

// A checkpoint is written and synced in the destination directory, then
// atomically replaces the previous report. Failures leave the last report.
export function writeReportCheckpoint(file, report,
  { writeTemp = durableWrite, replaceTemp = renameSync } = {}) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temp = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeTemp(temp, `${JSON.stringify(report, null, 2)}\n`);
    replaceTemp(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* It may have failed before creation. */ }
    throw error;
  }
}
