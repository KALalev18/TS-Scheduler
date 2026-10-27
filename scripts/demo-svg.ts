/**
 * Records the README demo: runs real CLI commands (real clock, temp file) and
 * renders their output as an animated SVG terminal. Run with `npm run demo`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli/program.js';

const COMMANDS: string[][] = [
  [
    'next',
    'FREQ=DAILY;BYHOUR=2;BYMINUTE=30',
    '--tz',
    'Europe/Berlin',
    '--start',
    '2026-03-27T00:00',
    '-n',
    '4',
  ],
  ['add', 'nightly backup', '--in', '1s', '--priority', '5', '--work', '1s'],
  [
    'add',
    'upload report',
    '--in',
    '1s',
    '--retries',
    '2',
    '--fail-first',
    '2',
    '--backoff',
    '300ms',
  ],
  ['add', 'send newsletter', '--in', '1s', '--deadline', '500ms'],
  [
    'add',
    'standup reminder',
    '--rrule',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=30',
    '--tz',
    'Europe/Helsinki',
  ],
  ['list'],
  ['run', '--for', '4s'],
];

const quote = (arg: string) => (/[\s;]/.test(arg) ? `"${arg}"` : arg);

interface Line {
  text: string;
  kind: 'prompt' | 'output';
  /** Seconds after the start of the animation when the line appears. */
  at: number;
}

async function record(): Promise<Line[]> {
  const dir = await mkdtemp(join(tmpdir(), 'ts-scheduler-demo-'));
  const lines: Line[] = [];
  let at = 0.3;
  try {
    for (const args of COMMANDS) {
      lines.push({ text: `$ ts-scheduler ${args.map(quote).join(' ')}`, kind: 'prompt', at });
      at += 0.9;
      const started = Date.now();
      const push = (text: string) => {
        for (const line of text.split('\n')) {
          // `run` output appears at the real moment it was printed.
          const offset = args[0] === 'run' ? (Date.now() - started) / 1000 : 0;
          lines.push({ text: line, kind: 'output', at: at + offset });
          if (args[0] !== 'run') at += 0.08;
        }
      };
      await runCli(args, {
        out: push,
        err: push,
        env: { TS_SCHEDULER_FILE: join(dir, 'schedule.json') },
        color: false,
      });
      if (args[0] === 'run') at += (Date.now() - started) / 1000;
      at += 0.7;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return lines;
}

const COLORS: [RegExp, string][] = [
  [/^\d\d:\d\d:\d\d {2}(started)/, '#56b6c2'],
  [/^\d\d:\d\d:\d\d {2}(done)/, '#98c379'],
  [/^\d\d:\d\d:\d\d {2}(failed)/, '#e06c75'],
  [/^\d\d:\d\d:\d\d {2}(missed)/, '#e5c07b'],
  [/^\d\d:\d\d:\d\d {2}(next)/, '#c678dd'],
];

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderLine(line: Line): string {
  if (line.kind === 'prompt') {
    return `<tspan fill="#61afef">$</tspan><tspan fill="#e6e6e6">${escape(line.text.slice(1))}</tspan>`;
  }
  for (const [pattern, color] of COLORS) {
    const m = pattern.exec(line.text);
    if (m?.[1]) {
      const label = m[1];
      const start = line.text.indexOf(label);
      return `<tspan fill="#7f848e">${escape(line.text.slice(0, start))}</tspan><tspan fill="${color}">${label}</tspan><tspan fill="#c8ccd4">${escape(line.text.slice(start + label.length))}</tspan>`;
    }
  }
  return `<tspan fill="#c8ccd4">${escape(line.text)}</tspan>`;
}

function render(lines: Line[]): string {
  const lineHeight = 17;
  const charWidth = 7.22;
  const padding = 18;
  const top = 44;
  const columns = Math.max(...lines.map((l) => l.text.length));
  const width = Math.ceil(columns * charWidth + 2 * padding);
  const height = top + lines.length * lineHeight + padding;
  const duration = (lines.at(-1)?.at ?? 0) + 4;
  const rows = lines
    .map((line, i) => {
      const y = top + (i + 1) * lineHeight - 4;
      const appear = ((line.at / duration) * 100).toFixed(2);
      return `<g class="l" style="animation-name:a${i}"><text x="${padding}" y="${y}" xml:space="preserve">${renderLine(line)}</text></g>
<style>@keyframes a${i}{0%,${appear}%{opacity:0}${Math.min(100, Number(appear) + 0.01).toFixed(2)}%,97%{opacity:1}100%{opacity:0}}</style>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="ts-scheduler CLI demo">
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px}
.l{opacity:0;animation-duration:${duration.toFixed(1)}s;animation-iteration-count:infinite;animation-timing-function:step-end}
@media (prefers-reduced-motion:reduce){.l{animation:none;opacity:1}}
</style>
<rect width="${width}" height="${height}" rx="8" fill="#282c34"/>
<circle cx="20" cy="18" r="6" fill="#ff5f56"/><circle cx="40" cy="18" r="6" fill="#ffbd2e"/><circle cx="60" cy="18" r="6" fill="#27c93f"/>
<text x="${width / 2}" y="22" text-anchor="middle" fill="#7f848e">ts-scheduler demo</text>
${rows}
</svg>
`;
}

const lines = await record();
await writeFile('docs/demo.svg', render(lines));
console.log(`wrote docs/demo.svg (${lines.length} lines)`);
