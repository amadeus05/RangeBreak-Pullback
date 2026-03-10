import 'reflect-metadata';
import { loadEnvFile } from 'node:process';
import { runBacktestCommand } from './presentation/cli/BacktestCommand';
import { runLiveCommand } from './presentation/cli/LiveCommand';
import { Logger, LogLevel } from './shared/logger/Logger';

function isEnvFlagEnabled(value?: string): boolean {
    if (!value) return false;

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

async function main() {
    loadEnvFile();

    const logger = Logger.getInstance();
    logger.setLogLevel(
        isEnvFlagEnabled(process.env.VERBOSE_TRADING_LOGS) ? LogLevel.DEBUG : LogLevel.INFO
    );

    const args = process.argv.slice(2);
    const mode = args[0];

    try {
        const symbolsArg = process.env.TRADING_SYMBOLS ?? '';
        const symbols = symbolsArg.split(',').map(s => s.trim()).filter(Boolean);

        if (symbols.length === 0) {
            throw new Error('TRADING_SYMBOLS is not set in .env');
        }

        if (mode === 'live') {
            logger.info(`Starting LIVE TRADING for symbols: ${symbols.join(', ')}...`);
            // await runLiveCommand({ symbols });
        }
        else {
            const defaultDays = 90;
            const defaultStartDay = 0;
            const defaultEndDay = 90;
            const defaultSlippageBps = 0.5;

            const days = parseInt(args[1]) || defaultDays;
            const startDay = args[2] ? parseInt(args[2]) : defaultStartDay;
            const endDay = args[3] ? parseInt(args[3]) : defaultEndDay;
            const slippageBps = args[4] ? parseFloat(args[4]) : defaultSlippageBps;

            let logMsg = `Starting BACKTEST for symbols: ${symbols.join(', ')} (last ${days} days)...`;
            if (startDay !== undefined || endDay !== undefined) {
                logMsg += ` [Shift: ${startDay ?? 0} to ${endDay ?? days}]`;
            }
            logMsg += ` [Slippage: ${slippageBps} bps]`;
            logger.info(logMsg);

            if (!mode) {
                logger.info('Tip: You can specify args: npm run dev backtest 90 10 60 0.5');
            }

            await runBacktestCommand({ symbols, days, startDay, endDay, slippageBps });
        }
    } catch (error) {
        logger.error('Application crashed', error);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
