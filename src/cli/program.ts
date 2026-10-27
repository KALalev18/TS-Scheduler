import { styleText } from 'node:util';
import { Command, CommanderError, Option } from 'commander';
import { Temporal } from 'temporal-polyfill';
import { systemClock, type Clock } from '../clock.js';
import { Recurrence } from '../recurrence.js';
import {
  Scheduler,
  type ScheduleInput,
  type TaskContext,
  type TaskSnapshot,
} from '../scheduler.js';
import { JsonFileStorage } from '../storage/json-file.js';
import packageJson from '../../package.json' with { type: 'json' };
import {
  formatClockTime,
  formatDuration,
  formatTime,
  parseDuration,
  parseInteger,
  table,
} from './format.js';
import { acquireLock, lockHolder, runningMessage } from './lock.js';

/** The CLI has one task type: print a message. Failures and work time can be simulated for demos. */
export interface CliPayloads {
  echo: { message: string; failFirst: number; workMs: number };
}

export interface CliIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  /** Resolves when the user asks `run` to stop (Ctrl+C). */
  readonly waitForInterrupt?: () => Promise<'graceful' | 'abort'>;
  /** Whether to use colours. Default: decided by Node from the output stream. */
  readonly color?: boolean;
}

type Style = Parameters<typeof styleText>[0];

interface AddOptions {
  at?: string;
  in?: string;
  rrule?: string;
  tz: string;
  start?: string;
  name?: string;
  priority: string;
  deadline?: string;
  onMissed: 'skip' | 'run';
  timeout?: string;
  retries: string;
  backoff: string;
  failFirst: string;
  work: string;
  jitter: 'full' | 'none';
}

function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const cancel = clock.setTimer(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        cancel();
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function describeSchedule(task: TaskSnapshot<CliPayloads>, timeZone: string): string {
  const { schedule } = task;
  if (schedule.kind === 'once') return `once at ${formatTime(schedule.at, timeZone)}`;
  const zone = Temporal.ZonedDateTime.from(schedule.start).timeZoneId;
  return `${schedule.rule} (${zone})`;
}

export function createProgram(io: CliIO): Command {
  const clock = io.clock ?? systemClock;
  const paint = (style: Style, text: string) =>
    io.color === false ? text : styleText(style, text, { validateStream: io.color !== true });
  const systemZone = Temporal.Now.timeZoneId();

  const program = new Command()
    .name('ts-scheduler')
    .description('Schedule tasks by priority, deadline and RRULE recurrence.')
    .version(packageJson.version)
    .option(
      '-f, --file <path>',
      'JSON file that stores the tasks',
      io.env.TS_SCHEDULER_FILE ?? './schedule.json',
    )
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  const createScheduler = (concurrency = 1) => {
    const { file } = program.opts<{ file: string }>();
    const log = (style: Style, label: string, task: TaskSnapshot<CliPayloads>, text = '') => {
      // Milliseconds make retry and backoff spacing visible.
      const time = formatClockTime(clock.now(), systemZone);
      const what = task.name ?? task.payload.message;
      io.out(
        `${paint('dim', time)}  ${paint(style, label.padEnd(9))} ${paint('dim', shortId(task.id))}  ${what}${text}`,
      );
    };
    const scheduler = new Scheduler<CliPayloads>({
      clock,
      concurrency,
      storage: new JsonFileStorage(file),
      handlers: {
        echo: async ({ payload, attempt, signal }: TaskContext<CliPayloads['echo']>) => {
          if (attempt <= payload.failFirst) {
            throw new Error(`simulated failure ${attempt}/${payload.failFirst}`);
          }
          if (payload.workMs > 0) await sleep(clock, payload.workMs, signal);
          io.out(`          ${paint('dim', '↳ output:')} ${payload.message}`);
        },
      },
    });
    scheduler.on('taskStarted', ({ task, attempt }) => {
      log('cyan', 'started', task, attempt > 1 ? paint('dim', ` (attempt ${attempt})`) : '');
    });
    scheduler.on('taskCompleted', ({ task, durationMs }) => {
      log('green', 'done', task, paint('dim', ` in ${formatDuration(durationMs)}`));
    });
    scheduler.on('taskFailed', ({ task, error, retryDelayMs }) => {
      const retry =
        retryDelayMs === null ? ', giving up' : `, retry in ${formatDuration(retryDelayMs)}`;
      log('red', 'failed', task, paint('dim', ` ${error.message}${retry}`));
    });
    scheduler.on('taskMissed', ({ task, deadline, action }) => {
      const late = formatDuration(clock.now() - deadline);
      const outcome = action === 'skip' ? 'skipped' : 'running it late';
      log('yellow', 'missed', task, paint('dim', ` missed its deadline by ${late}, ${outcome}`));
    });
    scheduler.on('taskScheduled', ({ task, runAt }) => {
      if (scheduler.isRunning)
        log('magenta', 'next', task, paint('dim', ` at ${formatTime(runAt, systemZone)}`));
    });
    scheduler.on('taskCancelled', ({ task }) => {
      log('yellow', 'cancelled', task);
    });
    scheduler.on('error', ({ error }) => {
      io.err(`${paint('red', 'error')} ${error.message}`);
    });
    return scheduler;
  };

  program
    .command('add')
    .description('Add a task that prints <message>')
    .argument('<message>', 'text to print when the task runs')
    .addOption(
      new Option(
        '--at <time>',
        'run once at an exact time, e.g. 2026-06-01T09:00:00+03:00',
      ).conflicts(['in', 'rrule']),
    )
    .addOption(new Option('--in <duration>', 'run once after a delay, e.g. 30s').conflicts('rrule'))
    .option('--rrule <rule>', 'run repeatedly, e.g. "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"')
    .option('--tz <zone>', 'time zone for --rrule', systemZone)
    .option('--start <datetime>', 'when the --rrule starts (default: now)')
    .option('--name <name>', 'label shown instead of the message')
    .option('-p, --priority <n>', 'higher runs first', '0')
    .option('--deadline <duration>', 'must start within this long of its scheduled time')
    .addOption(
      new Option('--on-missed <action>', 'what to do when the deadline passes')
        .choices(['skip', 'run'])
        .default('skip'),
    )
    .option('--timeout <duration>', 'fail an attempt that runs longer than this')
    .option('--retries <n>', 'extra attempts after a failure', '0')
    .option('--backoff <duration>', 'delay before the first retry (doubles each time)', '1s')
    .addOption(
      new Option('--jitter <mode>', 'randomise retry delays (full) or use exact doubling (none)')
        .choices(['full', 'none'])
        .default('full'),
    )
    .option('--fail-first <n>', 'simulate failure on the first n attempts', '0')
    .option('--work <duration>', 'simulate work taking this long', '0ms')
    .action(async (message: string, options: AddOptions) => {
      let schedule: ScheduleInput;
      if (options.rrule !== undefined) {
        schedule = {
          rrule: options.rrule,
          timeZone: options.tz,
          ...(options.start !== undefined && { start: options.start }),
        };
      } else if (options.at !== undefined) {
        schedule = { at: options.at };
      } else {
        schedule = { delayMs: options.in === undefined ? 0 : parseDuration(options.in) };
      }
      await ensureNotRunning();
      const scheduler = createScheduler();
      const task = await scheduler.add(
        'echo',
        {
          message,
          failFirst: parseInteger(options.failFirst, '--fail-first'),
          workMs: parseDuration(options.work),
        },
        schedule,
        {
          ...(options.name !== undefined && { name: options.name }),
          priority: Number(options.priority),
          ...(options.deadline !== undefined && {
            deadlineMs: parseDuration(options.deadline),
          }),
          onMissed: options.onMissed,
          ...(options.timeout !== undefined && { timeoutMs: parseDuration(options.timeout) }),
          retry: {
            maxAttempts: parseInteger(options.retries, '--retries') + 1,
            baseDelayMs: parseDuration(options.backoff),
            maxDelayMs: Math.max(60_000, parseDuration(options.backoff)),
            jitter: options.jitter,
          },
        },
      );
      await scheduler.stop();
      const runAt = task.nextRunAt ?? 0;
      const when =
        runAt - clock.now() < 1_000 ? 'runs now' : `first run ${formatTime(runAt, systemZone)}`;
      io.out(`added ${paint('bold', `"${task.name ?? message}"`)} (${shortId(task.id)}), ${when}`);
    });

  program
    .command('list')
    .alias('ls')
    .description('List tasks, soonest first')
    .option('--tz <zone>', 'time zone to show times in', systemZone)
    .action(async (options: { tz: string }) => {
      const scheduler = createScheduler();
      await scheduler.load();
      const tasks = scheduler.list();
      if (tasks.length === 0) {
        io.out('no tasks');
        return;
      }
      io.out(
        table(
          ['ID', 'TASK', 'STATE', 'PRI', 'NEXT RUN', 'RUNS', 'FAILS', 'SCHEDULE'],
          tasks.map((task) => [
            shortId(task.id),
            task.name ?? task.payload.message,
            task.state,
            String(task.priority),
            task.nextRunAt === null ? '-' : formatTime(task.nextRunAt, options.tz),
            String(task.runs),
            String(task.failures),
            describeSchedule(task, options.tz),
          ]),
        ),
      );
    });

  program
    .command('next')
    .description('Preview the next occurrences of an RRULE without saving anything')
    .argument('<rule>', 'e.g. "FREQ=DAILY;BYHOUR=2;BYMINUTE=30"')
    .option('--tz <zone>', 'time zone of the rule', systemZone)
    .option('--start <datetime>', 'start of the rule (default: now)')
    .option('-n, --count <n>', 'how many occurrences to show', '5')
    .action((rule: string, options: { tz: string; start?: string; count: string }) => {
      const recurrence = Recurrence.parse(rule, options.start ?? clock.now(), options.tz);
      const limit = parseInteger(options.count, '--count', 1);
      const times = recurrence.take(limit, recurrence.start.epochMilliseconds - 1);
      io.out(`${paint('bold', recurrence.toString())} in ${recurrence.timeZone}`);
      for (const t of times) io.out(`  ${formatTime(t, recurrence.timeZone)}`);
      if (times.length < limit) io.out(paint('dim', '  (no more occurrences)'));
    });

  program
    .command('remove')
    .alias('rm')
    .description('Delete a task by id (a unique prefix is enough)')
    .argument('<id>')
    .action(async (prefix: string) => {
      await ensureNotRunning();
      const scheduler = createScheduler();
      await scheduler.load();
      const matches = scheduler.list().filter((task) => task.id.startsWith(prefix));
      const [match, ...others] = matches;
      if (!match) throw new CommanderError(1, 'not-found', `no task matches "${prefix}"`);
      if (others.length > 0) {
        throw new CommanderError(1, 'ambiguous', `"${prefix}" matches ${matches.length} tasks`);
      }
      await scheduler.remove(match.id);
      await scheduler.stop();
      io.out(`removed ${shortId(match.id)}`);
    });

  program
    .command('run')
    .description('Run due tasks until Ctrl+C (or for a fixed time)')
    .option('-c, --concurrency <n>', 'tasks allowed to run at once', '1')
    .option('--for <duration>', 'stop after this long')
    .action(async (options: { concurrency: string; for?: string }) => {
      // Validate everything before taking the lock and starting.
      const concurrency = parseInteger(options.concurrency, '--concurrency', 1);
      const runForMs = options.for === undefined ? undefined : parseDuration(options.for);
      const release = await acquireLock(program.opts<{ file: string }>().file);
      try {
        await runUntilStopped(createScheduler(concurrency), runForMs);
      } finally {
        await release();
      }
    });

  const ensureNotRunning = async () => {
    const { file } = program.opts<{ file: string }>();
    const pid = await lockHolder(file);
    if (pid !== null) throw new Error(runningMessage(file, pid));
  };

  const runUntilStopped = async (scheduler: Scheduler<CliPayloads>, runForMs?: number) => {
    await scheduler.load();
    const pending = scheduler.list().filter((t) => t.state === 'pending').length;
    const tasks = pending === 1 ? '1 pending task' : `${pending} pending tasks`;
    io.out(paint('dim', `running ${tasks}, press Ctrl+C to stop`));
    await scheduler.start();
    const stopAfter =
      runForMs === undefined
        ? undefined
        : new Promise<'graceful'>((resolve) =>
            clock.setTimer(() => {
              resolve('graceful');
            }, runForMs),
          );
    const interrupt = io.waitForInterrupt?.() ?? new Promise<never>(() => undefined);
    const how = await Promise.race([interrupt, ...(stopAfter ? [stopAfter] : [])]);
    io.out(paint('dim', how === 'abort' ? 'aborting running tasks…' : 'stopping…'));
    await scheduler.stop({ abortRunning: how === 'abort' });
  };

  return program;
}

/** Runs the CLI and returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const program = createProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already printed its own errors (and help/version output).
      if (!['not-found', 'ambiguous'].includes(error.code)) return error.exitCode;
      io.err(`error: ${error.message}`);
      return error.exitCode;
    }
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
