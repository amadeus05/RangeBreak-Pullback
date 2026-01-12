import 'reflect-metadata';
import { runBacktestCommand } from './presentation/cli/BacktestCommand';
import { runLiveCommand } from './presentation/cli/LiveCommand';
import { Logger } from './shared/logger/Logger';

async function main() {
    const logger = Logger.getInstance();
    const args = process.argv.slice(2);
    const mode = args[0]; // 'backtest' или 'live'

    try {
        // Парсим список символов через запятую (напр. BTCUSDT,ETHUSDT,SOLUSDT)
        const symbolsArg = 'BTCUSDT,ETHUSDT,SOLUSDT';
        const symbols = symbolsArg.includes(',') 
            ? symbolsArg.split(',').map(s => s.trim()) 
            : [symbolsArg || (mode === 'live' ? 'DOGEUSDT' : 'SOLUSDT')];

        if (mode === 'live') {
            logger.info(`Starting LIVE TRADING for symbols: ${symbols.join(', ')}...`);
            // await runLiveCommand({ symbols });
        } 
        else {
            // По умолчанию запускаем Backtest
            const days = parseInt(args[2]) || 7; // 7 дней по умолчанию

            logger.info(`Starting BACKTEST for symbols: ${symbols.join(', ')} (last ${days} days)...`);
            if (!mode) {
                logger.info('Tip: You can specify args: npm run dev backtest ETHUSDT,BTCUSDT 180');
            }
            
            await runBacktestCommand({ symbols, days });
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