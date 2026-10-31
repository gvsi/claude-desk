/**
 * The Vision article's read time is worked out from its words (`READ_MINUTES` in `text.ts`), never written
 * down: no shipped source of the article holds a "5 min read" of its own. The screen test checks the number
 * against the page's words; this keeps a literal from standing in for it.
 *
 * The check first proves its matcher on known-bad samples, so it can't pass by matching nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A read time written out: a number, then "min read" or "minute(s) read".
const WRITTEN_READ_TIME = /\b\d+\s*min(?:ute)?s?\s+read\b/gi;

/** Each written read time in the article's shipped sources, as "file: match". Tests are left out. */
function writtenReadTimes(files: { file: string; text: string }[]): string[] {
  return files.flatMap(({ file, text }) => [...text.matchAll(WRITTEN_READ_TIME)].map((m) => `${file}: ${m[0]}`));
}

describe('the Vision article read time', () => {
  it('no_source_writes_the_read_time', () => {
    const bad = ['<span>5 min read</span>', "const meta = '12 minutes read';", '`6 min  read`'];
    expect(bad.map((text) => writtenReadTimes([{ file: 'x.tsx', text }]))).toEqual([
      ['x.tsx: 5 min read'],
      ['x.tsx: 12 minutes read'],
      ['x.tsx: 6 min  read'],
    ]);
    expect(writtenReadTimes([{ file: 'x.tsx', text: '<span>{`${READ_MINUTES} min read`}</span>' }])).toEqual([]);

    const shipped = readdirSync(HERE)
      .filter((file) => /\.(ts|tsx|css)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => ({ file, text: readFileSync(path.join(HERE, file), 'utf8') }));
    expect(shipped.map(({ file }) => file)).toEqual(expect.arrayContaining(['VisionArticle.tsx', 'text.ts', 'VisionArticle.css']));
    expect(writtenReadTimes(shipped)).toEqual([]);
  });
});
