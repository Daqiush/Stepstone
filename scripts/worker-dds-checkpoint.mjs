import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

function durableWrite(temp, content) {
  const fd = openSync(temp, 'wx');
  try { writeFileSync(fd, content); fsyncSync(fd); }
  finally { closeSync(fd); }
}

// Directory fsync makes create/rename durable on POSIX filesystems. Windows and
// some network filesystems do not permit opening a directory; those documented
// unsupported errors leave file fsync + atomic rename as the portable fallback.
export function syncParentDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EACCES'].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A checkpoint is written and synced in the destination directory, then
// atomically replaces the previous report. Failures leave the last report.
export function writeReportCheckpoint(file, report,
  { writeTemp = durableWrite, replaceTemp = renameSync, syncDirectory = syncParentDirectory } = {}) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temp = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeTemp(temp, `${JSON.stringify(report, null, 2)}\n`);
    syncDirectory(directory);
    replaceTemp(temp, file);
    syncDirectory(directory);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* It may have failed before creation. */ }
    throw error;
  }
}
