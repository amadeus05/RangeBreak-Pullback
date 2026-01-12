import { createContainer } from "../../config/inversify.config";
import {
  RunBacktest,
  BacktestConfig,
} from "../../application/use-cases/RunBacktest";
import { CandleRepository } from "../../infrastructure/database/repositories/CandleRepository";
import { TradeRepository } from "../../infrastructure/database/repositories/TradeRepository";
import { Logger } from "../../shared/logger/Logger";

export async function runBacktestCommand(args: {
  symbols: string[];
  days: number;
  balance?: number;
}): Promise<void> {
  const logger = Logger.getInstance();
  const initialBalance = args.balance || 500;
  
  // Передаём balance в контейнер
  const container = createContainer("backtest", initialBalance);
  const candleRepo = container.get<CandleRepository>(CandleRepository);
  const tradeRepo = container.get<TradeRepository>(TradeRepository);

  try {
    const backtestUseCase = container.get<RunBacktest>(RunBacktest);

    logger.info(
      `=== STARTING SYNCHRONIZED BACKTEST (${args.symbols.length} pairs) ===`
    );

    const config: BacktestConfig = {
      symbols: args.symbols,
      days: args.days,
      initialBalance
    };

    const result = await backtestUseCase.execute(config);

    logger.info("=== CUMULATIVE RESULTS ===");
    logger.info(`Total Trades: ${result.totalTrades}`);
    logger.info(`Win Rate: ${result.winRate.toFixed(2)}%`);
    logger.info(`Total P&L: ${result.totalPnl.toFixed(2)}`);
    logger.info(`Total Fees: ${result.totalFees?.toFixed(2)}`);
    logger.info(`Final Balance: ${result.finalBalance.toFixed(2)}`);
    if (result.profitFactor) {
      logger.info(`Profit Factor: ${result.profitFactor.toFixed(2)}`);
    }

    await candleRepo.disconnect();
    await tradeRepo.disconnect();
  } catch (error) {
    logger.error("Backtest failed", error);
    try {
      await candleRepo.disconnect();
      await tradeRepo.disconnect();
    } catch {}
    throw error;
  }
}