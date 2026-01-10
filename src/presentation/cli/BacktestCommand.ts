import { createContainer } from '../../config/inversify.config';
import { TYPES } from '../../config/types';
import { RunBacktest, BacktestConfig } from '../../application/use-cases/RunBacktest';
import { CandleRepository } from '../../infrastructure/database/repositories/CandleRepository';
import { TradeRepository } from '../../infrastructure/database/repositories/TradeRepository';
import { Logger } from '../../shared/logger/Logger';

export async function runBacktestCommand(args: {
    symbol: string;
    startDate: string;
    endDate: string;
    balance?: number;
}): Promise<void> {
    const logger = Logger.getInstance();
    
    try {
        const container = createContainer('backtest');
        
        const candleRepo = new CandleRepository();
        const tradeRepo = new TradeRepository();
        
        const backtestUseCase = new RunBacktest(
            container.get(TYPES.Strategy),
            container.get(TYPES.IExchange),
            candleRepo,
            tradeRepo
        );

        const config: BacktestConfig = {
            symbol: args.symbol,
            startDate: new Date(args.startDate),
            endDate: new Date(args.endDate),
            initialBalance: args.balance || 10000
        };

        const result = await backtestUseCase.execute(config);

        logger.info('=== BACKTEST RESULTS ===');
        logger.info(`Total Trades: ${result.totalTrades}`);
        logger.info(`Win Rate: ${result.winRate.toFixed(2)}%`);
        logger.info(`Total P&L: ${result.totalPnl.toFixed(2)}`);
        logger.info(`Final Balance: ${result.finalBalance.toFixed(2)}`);

        await candleRepo.disconnect();
        await tradeRepo.disconnect();
    } catch (error) {
        logger.error('Backtest failed', error);
        throw error;
    }
}