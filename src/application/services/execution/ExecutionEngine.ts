import { injectable, inject } from 'inversify';
import { TradingSignal } from '../../../domain/value-objects/TradingSignal';
import { Candle } from '../../../domain/entities/Candle';
import { TradeDirection } from '../../../domain/enums/TradeDirection';
import { IRiskEngine } from '../../../domain/interfaces/IRiskEngine';
import { PortfolioManager } from '../portfolio/PortfolioManager';
import { TradeRepository } from '../../../infrastructure/database/repositories/TradeRepository';
import { Logger } from '../../../shared/logger/Logger';
import { TYPES } from '../../../config/types';

interface PendingLimitOrder {
    signal: TradingSignal;
    timestamp: number;
}

interface PendingMarketOrder {
    signal: TradingSignal;
    timestamp: number;
}

interface ActivePosition {
    tradeId: number;
    signal: TradingSignal;
    size: number;
    entryPrice: number;
    entryTime: number;
    entryFee: number;
    entryMode: 'BAR_OPEN' | 'INTRABAR';
}

@injectable()
export class ExecutionEngine {
    private logger = Logger.getInstance();

    private pendingOrders: Map<string, PendingLimitOrder> = new Map();
    private pendingMarketOrders: Map<string, PendingMarketOrder> = new Map();
    private activePositions: Map<string, ActivePosition> = new Map();
    private lastCandles: Map<string, Candle> = new Map();

    private slippage = 0.0001;
    private readonly MAKER_FEE = 0.0002;
    private readonly TAKER_FEE = 0.0005;

    private readonly LEVERAGE = 10;
    private readonly MAINTENANCE_MARGIN = 0.005;

    constructor(
        @inject(TYPES.IRiskEngine) private readonly riskEngine: IRiskEngine,
        @inject(PortfolioManager) private readonly portfolio: PortfolioManager,
        @inject(TradeRepository) private readonly tradeRepo: TradeRepository
    ) { }

    setSlippage(slippage: number): void {
        if (!Number.isFinite(slippage) || slippage < 0) {
            this.logger.debug(`[EXECUTION] Invalid slippage value: ${slippage}`);
            return;
        }

        this.slippage = slippage;
    }

    async placeOrder(signal: TradingSignal): Promise<void> {
        if (!this.portfolio.canTrade()) {
            this.logger.debug('[EXECUTION] Kill switch active, order rejected');
            return;
        }

        if (this.activePositions.has(signal.symbol)) {
            this.logger.debug(`[EXECUTION] Position already exists for ${signal.symbol}`);
            return;
        }

        if (this.pendingOrders.has(signal.symbol) || this.pendingMarketOrders.has(signal.symbol)) {
            this.logger.debug(`[EXECUTION] Order already pending for ${signal.symbol}`);
            return;
        }

        if (signal.orderType === 'LIMIT') {
            this.placeLimitOrder(signal);
        } else {
            this.queueMarketOrder(signal);
        }
    }

    async onBarOpen(candle: Candle): Promise<void> {
        await this.executePendingMarketOrders(candle);
    }

    async onBarClose(candle: Candle): Promise<void> {
        this.lastCandles.set(candle.symbol, candle);
        await this.checkLimitOrders(candle);
        await this.managePositions(candle);
    }

    async onMarketData(candle: Candle): Promise<void> {
        await this.onBarClose(candle);
    }

    cancelOrder(symbol: string): void {
        if (this.pendingOrders.has(symbol)) {
            this.pendingOrders.delete(symbol);
            this.logger.debug(`[EXECUTION] Limit order cancelled for ${symbol}`);
        }
        if (this.pendingMarketOrders.has(symbol)) {
            this.pendingMarketOrders.delete(symbol);
            this.logger.debug(`[EXECUTION] Market order cancelled for ${symbol}`);
        }
    }

    async forceClosePosition(symbol: string, reason: string): Promise<void> {
        const pos = this.activePositions.get(symbol);
        if (!pos) return;

        const exitPrice = this.getCurrentPrice(symbol);
        if (exitPrice === 0) {
            this.logger.error(`[EXECUTION] Cannot force close ${symbol}: no price data`);
            return;
        }

        await this.closePosition(symbol, exitPrice, Date.now(), reason);
    }

    async closeAllOpenPositions(timestamp: number, reason: string): Promise<void> {
        const openSymbols = Array.from(this.activePositions.keys());
        for (const symbol of openSymbols) {
            const exitPrice = this.getCurrentPrice(symbol);
            if (exitPrice === 0) {
                this.logger.warn(`[EXECUTION] Cannot close ${symbol} at backtest end: no price data`);
                continue;
            }

            await this.closePosition(symbol, exitPrice, timestamp, reason);
        }
    }

    getUnrealizedPnl(): number {
        let totalUnrealizedPnl = 0;

        for (const [symbol, position] of this.activePositions.entries()) {
            const currentPrice = this.getCurrentPrice(symbol);
            if (currentPrice === 0) continue;

            totalUnrealizedPnl += position.signal.direction === TradeDirection.LONG
                ? (currentPrice - position.entryPrice) * position.size
                : (position.entryPrice - currentPrice) * position.size;
        }

        return totalUnrealizedPnl;
    }

    private placeLimitOrder(signal: TradingSignal): void {
        this.pendingOrders.set(signal.symbol, {
            signal,
            timestamp: signal.timestamp
        });

        const dateStr = new Date(signal.timestamp).toISOString().replace('T', ' ').substring(0, 19);
        this.logger.debug(
            `[${dateStr}] [LIMIT ORDER] ${signal.symbol} Placed ${signal.direction} @ ${signal.price.toFixed(2)} ` +
            `| SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)}`
        );
    }

    private queueMarketOrder(signal: TradingSignal): void {
        this.pendingMarketOrders.set(signal.symbol, {
            signal,
            timestamp: signal.timestamp
        });

        const dateStr = new Date(signal.timestamp).toISOString().replace('T', ' ').substring(0, 19);
        this.logger.debug(
            `[${dateStr}] [MARKET ORDER] ${signal.symbol} Queued ${signal.direction} @ ~${signal.price.toFixed(2)} ` +
            `| SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)}`
        );
    }

    private async executePendingMarketOrders(candle: Candle): Promise<void> {
        const order = this.pendingMarketOrders.get(candle.symbol);
        if (!order) return;

        if (candle.timestamp <= order.timestamp) return;

        let fillPrice = candle.open;
        if (order.signal.direction === TradeDirection.LONG) {
            fillPrice = fillPrice * (1 + this.slippage);
        } else {
            fillPrice = fillPrice * (1 - this.slippage);
        }

        const preparedOrder = this.prepareFilledOrder(order.signal, fillPrice);
        this.pendingMarketOrders.delete(candle.symbol);

        if (!preparedOrder) {
            return;
        }

        await this.openPosition(
            candle.symbol,
            preparedOrder.signal,
            preparedOrder.size,
            fillPrice,
            candle.timestamp,
            'BAR_OPEN'
        );
    }

    private async checkLimitOrders(candle: Candle): Promise<void> {
        const order = this.pendingOrders.get(candle.symbol);
        if (!order) return;

        if (candle.timestamp <= order.timestamp) return;

        const { signal, timestamp } = order;
        const { high, low } = candle;

        const filled = signal.direction === TradeDirection.LONG
            ? low <= signal.price
            : high >= signal.price;

        if (!filled) {
            if (candle.timestamp - timestamp > 120 * 60 * 1000) {
                this.logger.debug('[LIMIT ORDER] Expired (timeout 2h)');
                this.pendingOrders.delete(candle.symbol);
            }
            return;
        }

        let fillPrice = signal.price;
        if (signal.direction === TradeDirection.LONG) {
            fillPrice = fillPrice * (1 + this.slippage * 0.5);
        } else {
            fillPrice = fillPrice * (1 - this.slippage * 0.5);
        }

        const preparedOrder = this.prepareFilledOrder(signal, fillPrice);
        this.pendingOrders.delete(candle.symbol);

        if (!preparedOrder) {
            return;
        }

        await this.openPosition(
            candle.symbol,
            preparedOrder.signal,
            preparedOrder.size,
            fillPrice,
            candle.timestamp,
            'INTRABAR'
        );
    }

    private prepareFilledOrder(
        signal: TradingSignal,
        fillPrice: number
    ): { signal: TradingSignal; size: number } | null {
        if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
            this.logger.debug(`[EXECUTION] Invalid fill price for ${signal.symbol}`);
            return null;
        }

        const stopLoss = signal.stopLoss;
        const originalTakeProfit = signal.takeProfit;

        if (signal.direction === TradeDirection.LONG) {
            if (fillPrice <= stopLoss || fillPrice >= originalTakeProfit) {
                this.logger.debug(
                    `[EXECUTION] Skipping LONG ${signal.symbol}: fill ${fillPrice.toFixed(2)} invalidates setup ` +
                    `| SL ${stopLoss.toFixed(2)} | TP ${originalTakeProfit.toFixed(2)}`
                );
                return null;
            }
        } else {
            if (fillPrice >= stopLoss || fillPrice <= originalTakeProfit) {
                this.logger.debug(
                    `[EXECUTION] Skipping SHORT ${signal.symbol}: fill ${fillPrice.toFixed(2)} invalidates setup ` +
                    `| SL ${stopLoss.toFixed(2)} | TP ${originalTakeProfit.toFixed(2)}`
                );
                return null;
            }
        }

        const stopDistance = Math.abs(fillPrice - stopLoss);
        if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
            this.logger.debug(`[EXECUTION] Invalid stop distance for ${signal.symbol}`);
            return null;
        }

        const rrRatio = this.getRiskRewardRatio(signal);
        const takeProfit = signal.direction === TradeDirection.LONG
            ? fillPrice + stopDistance * rrRatio
            : fillPrice - stopDistance * rrRatio;

        const size = this.riskEngine.calculatePositionSize(
            this.portfolio.getBalance(),
            stopDistance
        );

        if (!Number.isFinite(size) || size <= 0) {
            this.logger.debug(`[EXECUTION] Invalid position size for ${signal.symbol}`);
            return null;
        }

        const adjustedSignal = signal.orderType === 'LIMIT'
            ? TradingSignal.createLimitOrder(
                signal.symbol,
                signal.direction,
                fillPrice,
                stopLoss,
                takeProfit,
                signal.timestamp,
                {
                    ...signal.meta,
                    rrRatio
                }
            )
            : TradingSignal.createMarketOrder(
                signal.symbol,
                signal.direction,
                fillPrice,
                stopLoss,
                takeProfit,
                signal.timestamp,
                {
                    ...signal.meta,
                    rrRatio
                }
            );

        return {
            signal: adjustedSignal,
            size
        };
    }

    private getRiskRewardRatio(signal: TradingSignal): number {
        const rrFromMeta = signal.meta?.rrRatio;
        if (typeof rrFromMeta === 'number' && Number.isFinite(rrFromMeta) && rrFromMeta > 0) {
            return rrFromMeta;
        }

        return signal.riskRewardRatio > 0 ? signal.riskRewardRatio : 1;
    }

    private async openPosition(
        symbol: string,
        signal: TradingSignal,
        size: number,
        entryPrice: number,
        timestamp: number,
        entryMode: 'BAR_OPEN' | 'INTRABAR'
    ): Promise<void> {
        const entryVolume = entryPrice * size;
        const entryFee = entryVolume * this.TAKER_FEE;
        this.portfolio.deductFee(entryFee);

        const tradeId = await this.tradeRepo.saveTrade({
            id: 0,
            symbol,
            direction: signal.direction,
            entryTime: timestamp,
            entryPrice,
            size,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            status: 'OPEN'
        });

        this.activePositions.set(symbol, {
            tradeId,
            signal,
            size,
            entryPrice,
            entryTime: timestamp,
            entryFee,
            entryMode
        });

        const dateStr = new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19);
        console.log(
            `[${dateStr}] 🚀 ${signal.symbol} ${signal.direction} @ ${entryPrice.toFixed(2)} ` +
            `| SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)} ` +
            `| Size: ${size.toFixed(4)} | Fee: ${entryFee.toFixed(4)}`
        );
    }

    private async managePositions(candle: Candle): Promise<void> {
        const pos = this.activePositions.get(candle.symbol);
        if (!pos) return;

        if (candle.timestamp === pos.entryTime && pos.entryMode !== 'BAR_OPEN') return;

        const { signal, entryPrice, size } = pos;
        const { high, low, timestamp } = candle;

        const liquidationPrice = this.calculateLiquidationPrice(entryPrice, signal.direction);

        let exitPrice: number | null = null;
        let exitReason = '';

        if (signal.direction === TradeDirection.LONG) {
            if (low <= liquidationPrice) {
                exitPrice = liquidationPrice;
                exitReason = 'LIQUIDATED';
            } else if (low <= signal.stopLoss) {
                exitPrice = signal.stopLoss;
                exitReason = 'Stop Loss';
            } else if (high >= signal.takeProfit) {
                exitPrice = signal.takeProfit;
                exitReason = 'Take Profit';
            }
        } else {
            if (high >= liquidationPrice) {
                exitPrice = liquidationPrice;
                exitReason = 'LIQUIDATED';
            } else if (high >= signal.stopLoss) {
                exitPrice = signal.stopLoss;
                exitReason = 'Stop Loss';
            } else if (low <= signal.takeProfit) {
                exitPrice = signal.takeProfit;
                exitReason = 'Take Profit';
            }
        }

        if (exitPrice !== null) {
            await this.closePosition(candle.symbol, exitPrice, timestamp, exitReason);
        }
    }

    private calculateLiquidationPrice(entryPrice: number, direction: TradeDirection): number {
        if (direction === TradeDirection.LONG) {
            return entryPrice * (1 - (1 / this.LEVERAGE) + this.MAINTENANCE_MARGIN);
        }

        return entryPrice * (1 + (1 / this.LEVERAGE) - this.MAINTENANCE_MARGIN);
    }

    private async closePosition(
        symbol: string,
        exitPrice: number,
        timestamp: number,
        reason: string
    ): Promise<void> {
        const pos = this.activePositions.get(symbol);
        if (!pos) return;

        const { signal, entryPrice, size, tradeId, entryFee } = pos;

        if (signal.direction === TradeDirection.LONG) {
            exitPrice = exitPrice * (1 - this.slippage);
        } else {
            exitPrice = exitPrice * (1 + this.slippage);
        }

        const rawPnl = signal.direction === TradeDirection.LONG
            ? (exitPrice - entryPrice) * size
            : (entryPrice - exitPrice) * size;

        const exitVol = exitPrice * size;
        const exitFee = reason.includes('Stop') || reason === 'LIQUIDATED'
            ? exitVol * this.TAKER_FEE
            : exitVol * this.MAKER_FEE;

        this.portfolio.deductFee(exitFee);

        const totalFee = entryFee + exitFee;
        const netPnl = rawPnl - totalFee;

        await this.tradeRepo.closeTrade(tradeId, exitPrice, timestamp, reason);
        this.portfolio.applyTradeResult({ pnl: rawPnl, fees: totalFee, netPnl });
        this.activePositions.delete(symbol);

        const dateStr = new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19);
        console.log(
            `[${dateStr}] 🏁 ${signal.symbol} ${signal.direction} @ ${exitPrice.toFixed(2)} ` +
            `(${this.formatExitReason(reason)}) | Net PnL: ${this.colorizePnl(netPnl)} | Fees: ${totalFee.toFixed(4)}`
        );
    }

    private getCurrentPrice(symbol: string): number {
        const candle = this.lastCandles.get(symbol);
        return candle ? candle.close : 0;
    }

    private formatExitReason(reason: string): string {
        switch (reason) {
            case 'Take Profit':
                return '✅ Take Profit';
            case 'Stop Loss':
                return '❌ Stop Loss';
            default:
                return reason;
        }
    }

    private colorizePnl(netPnl: number): string {
        const color = netPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
        return `${color}${netPnl.toFixed(2)}\x1b[0m`;
    }
}
