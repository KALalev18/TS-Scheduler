import { runCli } from './program.js';

/** First Ctrl+C stops gracefully (waits for running tasks); a second one aborts them. */
function waitForInterrupt(): Promise<'graceful' | 'abort'> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => {
      process.once('SIGINT', () => {
        resolve('abort');
      });
      resolve('graceful');
    });
    process.once('SIGTERM', () => {
      resolve('graceful');
    });
  });
}

process.exitCode = await runCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  waitForInterrupt,
});
