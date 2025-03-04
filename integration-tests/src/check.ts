import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChalkInstance } from 'chalk';
import chalk from 'chalk';
import Shell from 'shelljs';

import { readConfig, resolveArgs, resolveRepArgs } from './config.js';
import type { Repository } from './configDef.js';
import { formatExecOutput } from './outputHelper.js';
import { PrefixLogger } from './PrefixLogger.js';
import { addRepository, checkoutRepositoryAsync, repositoryDir } from './repositoryHelper.js';
import { execAsync } from './sh.js';
import { shouldCheckRepo } from './shouldCheckRepo.js';
import {
    checkAgainstReportSnapshot,
    checkAgainstSnapshot,
    readReportSnapshot,
    writeReportSnapshot,
} from './snapshots.js';
import type { Logger } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const config = readConfig();
const cspellArgs =
    '--no-progress --relative --show-context --gitignore --gitignore-root=. --reporter=default --reporter=${pathReporter}';
const cspellArgsListAllFiles =
    '--no-progress --relative --show-context --gitignore --gitignore-root=. --reporter=default --reporter=${pathReporterListAll}';
const jsCspell = JSON.stringify(Path.resolve(__dirname, '../../bin.mjs'));

const envVariables: string[] = [
    'CSPELL_ENABLE_DICTIONARY_LOGGING',
    'CSPELL_ENABLE_DICTIONARY_LOG_FILE',
    'CSPELL_ENABLE_DICTIONARY_LOG_FIELDS',
    'CSPELL_GLOB_ROOT',
];

let checkCount = 0;

const colors = [
    tfn(chalk.green),
    tfn(chalk.blue),
    tfn(chalk.yellow),
    tfn(chalk.cyan),
    tfn(chalk.magenta),
    tfn(chalk.rgb(255, 192, 64)),
];

interface Result {
    stdout: string;
    stderr: string;
    code: number;
    elapsedTime: number;
}

interface CheckContext {
    color: (strings: string | TemplateStringsArray, ...rest: unknown[]) => string;
    logger: Logger;
    rep: Repository;
    cpuProf: boolean;
}

interface CheckAndUpdateOptions {
    update: boolean;
    updateSnapshots: boolean;
    cpuProf: boolean;
}

async function execCheckAndUpdate(rep: Repository, options: CheckAndUpdateOptions): Promise<CheckResult> {
    const name = rep.path;
    const color = colors[checkCount % colors.length];
    const prefix = color(name + '\t ');
    const logger = new PrefixLogger(prefix);
    const { log } = logger;
    ++checkCount;

    if (options.update) {
        log('');
        log(color`**********************************************`);
        log(color`*  Updating Repo: `);
        log(color`*    '${name}'`);
        log(color`*    url:    ${rep.url}`);
        log(color`*    commit: ${rep.commit}`);
        log(color`**********************************************\n`);
        const oldCommit = rep.commit;
        try {
            const updatedRep = mustBeDefined(await addRepository(logger, rep.url, rep.branch));
            rep = resolveRepArgs(updatedRep);
        } catch {
            log(color`******** fail ********`);
            return { success: false, rep, elapsedTime: 0 };
        }
        log(color`******** Updating Repo Complete ********`);
        if (rep.commit !== oldCommit) {
            log(color`******** Updated repo commit: ********`);
            log(color`********   From: ${oldCommit} ********`);
            log(color`********   To:   ${rep.commit} ********`);
        } else {
            log(color`******** No changes to commit ********`);
        }
    }
    const context: CheckContext = {
        color,
        logger,
        rep,
        cpuProf: options.cpuProf,
    };

    return execCheck(context, options.update || options.updateSnapshots);
}

async function execCheck(context: CheckContext, update: boolean): Promise<CheckResult> {
    const { rep, logger, color } = context;
    const name = rep.path;
    const path = Path.join(repositoryDir, rep.path);
    const nodeArgs = context.cpuProf ? ['--cpu-prof', '--cpu-prof-dir="../../../.."'] : [];
    const uniqueArgs = rep.uniqueOnly !== false ? ['--unique'] : [];
    const cmdArgs = rep.listAllFiles ? cspellArgsListAllFiles : cspellArgs;
    const cmdToExec = resolveArgs(rep.path, [genLaunchCSpellCommand(nodeArgs), cmdArgs, ...uniqueArgs]).join(' ');
    const { log } = logger;
    const env = getEnvVariables();
    ++checkCount;

    log('');
    log(color`**********************************************`);
    log(color`*  Checking: `);
    log(color`*    '${name}'`);
    log(color`**********************************************\n`);
    log(time());
    const originalReport = await readReportSnapshot(rep);
    if (!(await checkoutRepositoryAsync(logger, rep.url, rep.path, rep.commit, rep.branch))) {
        logger.log('******** fail ********');
        return { success: false, rep, elapsedTime: 0 };
    }
    log(time());
    if (!(await execPostCheckoutSteps(context))) {
        logger.log('******** fail ********');
        return { success: false, rep, elapsedTime: 0 };
    }
    log(time());
    const cspellResult = await execCommand({ logger, path, command: cmdToExec, args: rep.args, env });
    log(resultReport(cspellResult));
    log(time());
    log(color`\n************ Checking Results ************`);

    if (update) {
        log(color`************ Update Snapshot *************`);
    }
    const r = await checkResult(rep, cspellResult, originalReport, update);
    log(time());
    if (r.diff) {
        log(r.diff);
        log('');
    }
    if (!update) {
        // Restore the original report.
        await writeReportSnapshot(rep, originalReport);
    }
    log(color`\n************ Done: ${name} ************\n`);
    return { success: r.match, rep, elapsedTime: cspellResult.elapsedTime };
}

function time() {
    return new Date().toISOString();
}

interface ExecCommandOptions {
    logger: Logger;
    path: string;
    command: string;
    args: string[];
    env?: Record<string, string> | undefined;
}

async function execCommand({ logger, path, command, args, env }: ExecCommandOptions): Promise<Result> {
    const start = Date.now();
    const argv = args.map((a) => JSON.stringify(a)).join(' ');
    const fullCommand = command + ' ' + argv;
    Shell.pushd('-q', path);
    logger.log(`Execute: '${fullCommand}'`);
    const pResult = execAsync(fullCommand, { env });
    Shell.popd('-q', '+0');
    const result = await pResult;
    const { stdout, stderr, code } = result;
    return cleanResult({
        stdout,
        stderr,
        code,
        elapsedTime: Date.now() - start,
    });
}

async function execPostCheckoutSteps(context: CheckContext) {
    const { rep, logger } = context;
    const path = Path.join(repositoryDir, rep.path);

    const steps = rep.postCheckoutSteps || [];
    for (const step of steps) {
        logger.log(`Step: %j`, step);
        const r = await execCommand({ logger, path, command: step, args: [] });
        if (r.code !== 0) {
            logger.error(r.stderr);
            return false;
        }
    }
    return true;
}

function resultReport(result: Result) {
    const fullOutputLines = formatExecOutput(result).split('\n');
    return (fullOutputLines.length > 7 ? '...\n' : '') + fullOutputLines.slice(-7).join('\n');
}

function assembleOutput(result: Result) {
    const { stdout, stderr, code } = result;
    return `${stdout} ${stderr} exit code: ${code}`;
}

async function checkResult(rep: Repository, result: Result, originalReport: string, update: boolean) {
    const snapDiff = await checkAgainstSnapshot(rep, assembleOutput(result), update);
    if (update) return snapDiff;
    const reportDiff = await checkAgainstReportSnapshot(rep, originalReport);
    return reportDiff.match ? snapDiff : reportDiff;
}

function cleanResult(result: Result): Result {
    const { stderr, stdout, ...rest } = result;
    return {
        ...rest,
        stderr: cleanOutput(stderr),
        stdout: cleanOutput(stdout),
    };
}

function cleanOutput(out: string): string {
    const parent = Path.resolve(Path.join(__dirname, '..', '..'));
    out = out.replaceAll(/\(node:\d+\)/g, '(node:0000)');
    return out
        .split('\n')
        .map((line) => line.replace(repositoryDir, '.'))
        .map((line) => line.replace(parent, '.'))
        .join('\n');
}

function rightJustify(s: string, w: number) {
    return (' '.repeat(w) + s).slice(-w);
}

function report(reposChecked: Repository[], results: CheckResult[]) {
    const sorted = [...reposChecked];
    sorted.sort((a, b) => a.path.localeCompare(b.path));
    const resultsByRep = new Map(results.map((r) => [r.rep, r]));
    const w = Math.max(...reposChecked.map((r) => r.path.length));
    const r = sorted.map((r) => {
        const { success, elapsedTime = 0 } = resultsByRep.get(r) || {};
        const mark = success === undefined ? '🛑' : success === false ? '❌' : '✅';
        const time = chalk.gray(rightJustify(elapsedTime ? `${(elapsedTime / 1000).toFixed(3)}s` : '', 9));
        const padding = ' '.repeat(w - r.path.length);
        return `\t ${mark}  ${r.path} ${padding} ${time}`;
    });
    return r.join('\n');
}

export interface CheckOptions {
    /** Exclusion patterns */
    exclude: string[];
    /** Update ALL */
    update: boolean;
    /** Only update the snapshot */
    updateSnapshots: boolean;
    /** Stop on first error */
    fail: boolean;
    /** Max number of parallel processes */
    parallelLimit: number;
    /** Turn on NodeJS --cpu-prof */
    cpuProf: boolean;
}

type PendingState = 'pending' | 'rejected' | 'resolved';

interface PendingPromise<T> {
    state: PendingState;
    promise: Promise<T>;
}

function asPendingPromise<T>(promise: Promise<T>): PendingPromise<T> {
    const pp: PendingPromise<T> = {
        promise,
        state: 'pending',
    };

    promise.then((v) => ((pp.state = 'resolved'), v)).catch((r) => ((pp.state = 'rejected'), r));

    return pp;
}

/**
 * Parallel Process some values using the mapFn while limiting the number
 * running in parallel.
 * @param values the values to map
 * @param mapFn a mapping function that returns a promise
 * @param limit the max number of pending promises.
 */
async function* asyncBuffer<T, U>(
    values: Iterable<T> | AsyncIterable<T>,
    mapFn: (v: T, i: number) => Promise<U>,
    limit: number,
): AsyncIterable<U> {
    let pending: PendingPromise<U>[] = [];
    let index = 0;
    for await (const v of values) {
        const p = mapFn(v, index);
        pending.push(asPendingPromise(p));
        if (limit > 0 && pending.length >= limit) {
            await Promise.race(pending.map((pp) => pp.promise));
            const stillPending: PendingPromise<U>[] = [];
            for (const p of pending) {
                if (p.state === 'pending') {
                    stillPending.push(p);
                } else {
                    yield p.promise;
                }
            }
            pending = stillPending;
        }
        index++;
    }
    yield* pending.map((p) => p.promise);
    return;
}

interface CheckResult {
    success: boolean;
    elapsedTime: number;
    rep: Repository;
}

function tf(v: boolean | undefined): 'true' | 'false' {
    return v ? 'true' : 'false';
}

export async function check(patterns: string[], options: CheckOptions): Promise<void> {
    const { exclude, update, updateSnapshots, fail, parallelLimit } = options;
    const matching = config.repositories
        .filter((rep) => shouldCheckRepo(rep, { patterns, exclude }))
        .map(resolveRepArgs);

    console.log(`
Check
Patterns:       [${patterns.join(', ') || '*'}]
Exclude:        [${exclude.join(', ')}]
Update:         ${tf(update)}
Parallel:       ${parallelLimit}
Stop on fail:   ${tf(fail)}

`);

    const results: CheckResult[] = [];

    const buffered = asyncBuffer(
        matching,
        async (rep) => execCheckAndUpdate(rep, { update, updateSnapshots, cpuProf: options.cpuProf }),
        parallelLimit,
    );

    for await (const r of buffered) {
        results.push(r);
        if (fail && !r.success) {
            break;
        }
    }

    const failed: Repository[] = results.filter((r) => !r.success).map((r) => r.rep);

    const success = results.length === matching.length && !failed.length;
    console.log();
    console.log(
        failed.length ? 'Some checks failed:' : !matching.length ? 'No Repositories Found' : 'All checks passed:',
    );
    console.log(report(matching, results));

    if (!success) {
        process.exitCode = 1;
    } else {
        console.log('\nSuccess!');
    }
}

function mustBeDefined<T>(t: T | undefined): T {
    if (t === undefined) {
        throw new Error('Must not be undefined.');
    }
    return t;
}

function tfn(colorFn: ChalkInstance): (strings: string | TemplateStringsArray, ...rest: unknown[]) => string {
    return (strings, ...rest) => {
        if (typeof strings === 'string') return colorFn(strings);

        const parts: string[] = [];
        let i = 0;
        for (; i < strings.length - 1; ++i) {
            parts.push(strings[i], rest[i] as string);
        }
        if (i < strings.length) {
            parts.push(strings[i]);
        }
        return colorFn(parts.join(''));
    };
}

function genLaunchCSpellCommand(nodeArgs: string[]) {
    return `node ${nodeArgs.join(' ')} ${jsCspell}`;
}

function getEnvVariables(): Record<string, string> | undefined {
    const env: Record<string, string> = {};
    for (const key of envVariables) {
        const value = process.env[key];
        if (value) {
            env[key] = value;
        }
    }
    return Object.keys(env).length ? env : undefined;
}
