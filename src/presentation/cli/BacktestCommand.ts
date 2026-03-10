import { createContainer } from "../../config/inversify.config";
import {
  RunBacktest,
  BacktestConfig,
  DirectionTradeStats,
  MonthlyTradeStats,
  SymbolTradeStats,
} from "../../application/use-cases/RunBacktest";
import { CandleRepository } from "../../infrastructure/database/repositories/CandleRepository";
import { TradeRepository } from "../../infrastructure/database/repositories/TradeRepository";
import { Logger } from "../../shared/logger/Logger";

export async function runBacktestCommand(args: {
  symbols: string[];
  days: number;
  startDay?: number;
  endDay?: number;
  balance?: number;
  slippageBps?: number;
}): Promise<void> {
  const logger = Logger.getInstance();
  const initialBalance = args.balance || 500;

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
      startDay: args.startDay,
      endDay: args.endDay,
      initialBalance,
      slippageBps: args.slippageBps,
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
    logger.info(formatDirectionSummary(result.directionStats.long, result.directionStats.short));
    logger.info(formatMonthlyStatsTable(result.monthlyStats));
    logger.info(formatSymbolStatsTable(result.symbolStats));

    await candleRepo.disconnect();
    await tradeRepo.disconnect();
  } catch (error) {
    logger.error("Backtest failed", error);
    try {
      await candleRepo.disconnect();
      await tradeRepo.disconnect();
    } catch { }
    throw error;
  }
}

function formatDirectionSummary(longStats: DirectionTradeStats, shortStats: DirectionTradeStats): string {
  const headers = ["Direction", "Total", "Win", "Loss", "PnL"];
  const rows = [
    [
      "LONG",
      String(longStats.totalTrades),
      String(longStats.winningTrades),
      String(longStats.losingTrades),
      longStats.totalPnl.toFixed(2),
    ],
    [
      "SHORT",
      String(shortStats.totalTrades),
      String(shortStats.winningTrades),
      String(shortStats.losingTrades),
      shortStats.totalPnl.toFixed(2),
    ],
  ];

  return ["=== DIRECTION SUMMARY ===", formatTable(headers, rows)].join("\n");
}

function formatMonthlyStatsTable(monthlyStats: MonthlyTradeStats[]): string {
  if (monthlyStats.length === 0) {
    return "=== MONTHLY TRADE SUMMARY ===\nNo closed trades.";
  }

  const headers = ["Month", "Total", "Win", "Loss", "PnL"];
  const rows = monthlyStats.map((stat) => [
    stat.month,
    String(stat.totalTrades),
    String(stat.winningTrades),
    String(stat.losingTrades),
    stat.totalPnl.toFixed(2),
  ]);

  return ["=== MONTHLY TRADE SUMMARY ===", formatTable(headers, rows)].join("\n");
}

function formatSymbolStatsTable(symbolStats: SymbolTradeStats[]): string {
  if (symbolStats.length === 0) {
    return "=== SYMBOL TRADE SUMMARY ===\nNo closed trades.";
  }

  const headers = ["Symbol", "Total", "Win", "Loss", "PnL"];
  const rows = symbolStats.map((stat) => [
    stat.symbol,
    String(stat.totalTrades),
    String(stat.winningTrades),
    String(stat.losingTrades),
    stat.totalPnl.toFixed(2),
  ]);

  return ["=== SYMBOL TRADE SUMMARY ===", formatTable(headers, rows)].join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );

  const formatRow = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index])).join(" | ");

  const separator = widths.map((width) => "-".repeat(width)).join("-+-");

  return [formatRow(headers), separator, ...rows.map(formatRow)].join("\n");
}
