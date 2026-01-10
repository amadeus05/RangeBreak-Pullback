import { createContainer } from '../../config/inversify.config';
import { RunBacktest, BacktestConfig } from '../../application/use-cases/RunBacktest';
import { CandleRepository } from '../../infrastructure/database/repositories/CandleRepository';
import { TradeRepository } from '../../infrastructure/database/repositories/TradeRepository';
import { Logger } from '../../shared/logger/Logger';

export async function runBacktestCommand(args: {
    symbol: string;
    days: number;
    balance?: number;
}): Promise<void> {
    const logger = Logger.getInstance();
    
    // Создаем репозитории вне контейнера для корректного закрытия соединений (prisma disconnect)
    // ИЛИ получаем их из контейнера. В данном случае удобнее получить из контейнера и потом закрыть.
    
    const container = createContainer('backtest');

    try {
        // Получаем UseCase (он сам подтянет Strategy, Repositories, Exchanges)
        const backtestUseCase = container.get<RunBacktest>(RunBacktest);
        const candleRepo = container.get<CandleRepository>(CandleRepository);
        const tradeRepo = container.get<TradeRepository>(TradeRepository);

        const config: BacktestConfig = {
            symbol: args.symbol,
            days: args.days,
            initialBalance: args.balance || 500
        };

        const result = await backtestUseCase.execute(config);

        logger.info('=== BACKTEST RESULTS ===');
        logger.info(`Total Trades: ${result.totalTrades}`);
        logger.info(`Win Rate: ${result.winRate.toFixed(2)}%`);
        logger.info(`Total P&L: ${result.totalPnl.toFixed(2)}`);
        logger.info(`Final Balance: ${result.finalBalance.toFixed(2)}`);
        if (result.profitFactor) {
            logger.info(`Profit Factor: ${result.profitFactor.toFixed(2)}`);
        }

        // Закрываем соединения с БД
        await candleRepo.disconnect();
        await tradeRepo.disconnect();

    } catch (error) {
        logger.error('Backtest failed', error);
        throw error;
    }
}