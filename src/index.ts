import 'reflect-metadata';
import { runBacktestCommand } from './presentation/cli/BacktestCommand';
import { runLiveCommand } from './presentation/cli/LiveCommand';
import { Logger } from './shared/logger/Logger';

async function main() {
    const logger = Logger.getInstance();
    const args = process.argv.slice(2);
    const mode = args[0]; // 'backtest' или 'live'

    try {
        if (mode === 'live') {
            const symbol = args[1] || 'BTCUSDT';
            logger.info(`Starting LIVE TRADING for ${symbol}...`);
            await runLiveCommand({ symbol });
        } 
        else {
            // По умолчанию запускаем Backtest
            const symbol = args[1] || 'BTCUSDT';
            const days = parseInt(args[2]) || 7; // 360 дней по умолчанию

            logger.info(`Starting BACKTEST for ${symbol} (last ${days} days)...`);
            if (!mode) {
                logger.info('Tip: You can specify args: npm run dev backtest ETHUSDT 180');
            }
            
            await runBacktestCommand({ symbol, days });
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