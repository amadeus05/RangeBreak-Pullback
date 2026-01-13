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
    size: number;
    timestamp: number;
}

interface PendingMarketOrder {
    signal: TradingSignal;
    size: number;
    timestamp: number;
}

interface ActivePosition {
    tradeId: number;
    signal: TradingSignal;
    size: number;
    entryPrice: number;
    entryTime: number;
    entryFee: number;
}

@injectable()
export class ExecutionEngine {
    private logger = Logger.getInstance();

    private pendingOrders: Map<string, PendingLimitOrder> = new Map();
    private pendingMarketOrders: Map<string, PendingMarketOrder> = new Map();
    private activePositions: Map<string, ActivePosition> = new Map();
    private lastCandles: Map<string, Candle> = new Map();

    private readonly TRADING_FEE = 0.00055;
    private readonly SLIPPAGE = 0.0001;
    private readonly MAKER_FEE = 0.0002;
    private readonly TAKER_FEE = 0.0005;

    // Leverage & Liquidation settings
    private readonly LEVERAGE = 10;
    private readonly MAINTENANCE_MARGIN = 0.005; // 0.5%

    constructor(
        @inject(TYPES.IRiskEngine) private readonly riskEngine: IRiskEngine,
        @inject(PortfolioManager) private readonly portfolio: PortfolioManager,
        @inject(TradeRepository) private readonly tradeRepo: TradeRepository
    ) { }

    // ═══════════════════════════════════════════
    // ПУБЛИЧНЫЙ API
    // ═══════════════════════════════════════════

    // 1. Размещение ордера (LIMIT или MARKET)
    async placeOrder(signal: TradingSignal): Promise<void> {
        if (!this.portfolio.canTrade()) {
            this.logger.warn('[EXECUTION] Kill switch active, order rejected');
            return;
        }

        // Проверяем, нет ли уже позиции по этому символу
        if (this.activePositions.has(signal.symbol)) {
            this.logger.warn(`[EXECUTION] Position already exists for ${signal.symbol}`);
            return;
        }

        // Проверяем, нет ли уже pending ордера
        if (this.pendingOrders.has(signal.symbol) || this.pendingMarketOrders.has(signal.symbol)) {
            this.logger.warn(`[EXECUTION] Order already pending for ${signal.symbol}`);
            return;
        }

        const size = this.riskEngine.calculatePositionSize(
            this.portfolio.getBalance(),
            signal.stopDistance
        );

        if (signal.orderType === 'LIMIT') {
            this.placeLimitOrder(signal, size);
        } else {
            this.queueMarketOrder(signal, size);
        }
    }

    // 2. Обработка тика рынка (проверяем лимиты и позиции)
    async onMarketData(candle: Candle): Promise<void> {
        // Store last candle for getCurrentPrice()
        this.lastCandles.set(candle.symbol, candle);

        // 1. Execute pending MARKET orders (fill at candle.open)
        await this.executePendingMarketOrders(candle);

        // 2. Check LIMIT orders
        await this.checkLimitOrders(candle);

        // 3. Manage positions (SL/TP/Liquidation)
        await this.managePositions(candle);
    }

    // 3. Отмена ордера
    cancelOrder(symbol: string): void {
        if (this.pendingOrders.has(symbol)) {
            this.pendingOrders.delete(symbol);
            this.logger.info(`[EXECUTION] Limit order cancelled for ${symbol}`);
        }
        if (this.pendingMarketOrders.has(symbol)) {
            this.pendingMarketOrders.delete(symbol);
            this.logger.info(`[EXECUTION] Market order cancelled for ${symbol}`);
        }
    }

    // 4. Принудительное закрытие
    async forceClosePosition(symbol: string, reason: string): Promise<void> {
        const pos = this.activePositions.get(symbol);
        if (!pos) return;

        // Use last known candle price
        const exitPrice = this.getCurrentPrice(symbol);
        if (exitPrice === 0) {
            this.logger.error(`[EXECUTION] Cannot force close ${symbol}: no price data`);
            return;
        }
        await this.closePosition(symbol, exitPrice, Date.now(), reason);
    }

    // ═══════════════════════════════════════════
    // ПРИВАТНАЯ ЛОГИКА
    // ═══════════════════════════════════════════

    private placeLimitOrder(signal: TradingSignal, size: number): void {
        this.pendingOrders.set(signal.symbol, {
            signal,
            size,
            timestamp: signal.timestamp
        });

        const dateStr = new Date(signal.timestamp).toISOString().replace('T', ' ').substring(0, 19);
        this.logger.info(
            `[${dateStr}] [LIMIT ORDER] Placed ${signal.direction} @ ${signal.price.toFixed(2)} ` +
            `| SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)} | Size: ${size.toFixed(4)}`
        );
    }

    private queueMarketOrder(signal: TradingSignal, size: number): void {
        // Queue for execution on next candle (realistic behavior)
        this.pendingMarketOrders.set(signal.symbol, {
            signal,
            size,
            timestamp: signal.timestamp
        });

        const dateStr = new Date(signal.timestamp).toISOString().replace('T', ' ').substring(0, 19);
        this.logger.info(
            `[${dateStr}] [MARKET ORDER] Queued ${signal.direction} @ ~${signal.price.toFixed(2)} ` +
            `| SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)} | Size: ${size.toFixed(4)}`
        );
    }

    private async executePendingMarketOrders(candle: Candle): Promise<void> {
        const order = this.pendingMarketOrders.get(candle.symbol);
        if (!order) return;

        // ❌ FIX #2: MARKET order can only execute AFTER signal candle
        if (candle.timestamp <= order.timestamp) return;

        let fillPrice = candle.open;
        if (order.signal.direction === TradeDirection.LONG) {
            fillPrice = fillPrice * (1 + this.SLIPPAGE);
        } else {
            fillPrice = fillPrice * (1 - this.SLIPPAGE);
        }

        await this.openPosition(
            candle.symbol,
            order.signal,
            order.size,
            fillPrice,
            candle.timestamp
        );

        this.pendingMarketOrders.delete(candle.symbol);
    }

    private async checkLimitOrders(candle: Candle): Promise<void> {
        const order = this.pendingOrders.get(candle.symbol);
        if (!order) return;

        // ❌ FIX #3: LIMIT order can only fill AFTER signal candle
        if (candle.timestamp <= order.timestamp) return;

        const { signal, size, timestamp } = order;
        const { high, low } = candle;

        let filled = false;

        if (signal.direction === TradeDirection.LONG) {
            if (low <= signal.price) filled = true;
        } else {
            if (high >= signal.price) filled = true;
        }

        if (!filled) {
            // Таймаут 2 часа
            if (candle.timestamp - timestamp > 120 * 60 * 1000) {
                this.logger.info('[LIMIT ORDER] Expired (timeout 2h)');
                this.pendingOrders.delete(candle.symbol);
            }
            return;
        }

        // Исполнен
        let fillPrice = signal.price;
        if (signal.direction === TradeDirection.LONG) {
            fillPrice = fillPrice * (1 + this.SLIPPAGE * 0.5);
        } else {
            fillPrice = fillPrice * (1 - this.SLIPPAGE * 0.5);
        }

        await this.openPosition(candle.symbol, signal, size, fillPrice, candle.timestamp);
        this.pendingOrders.delete(candle.symbol);
    }

    private async openPosition(
        symbol: string,
        signal: TradingSignal,
        size: number,
        entryPrice: number,
        timestamp: number
    ): Promise<void> {
        // ❌ FIX #5: Deduct entry fee IMMEDIATELY
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
            entryFee
        });

        const dateStr = new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19);
        this.logger.info(
            `[${dateStr}] ➡️[EXECUTION] Entry ${signal.direction} @ ${entryPrice.toFixed(2)} ` +
            `| SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)} | Fee: ${entryFee.toFixed(4)}`
        );
    }

    private async managePositions(candle: Candle): Promise<void> {
        const pos = this.activePositions.get(candle.symbol);
        if (!pos) return;

        // ❌ FIX #1: Skip management on entry candle
        // We don't know if low/high was BEFORE or AFTER our entry
        if (candle.timestamp === pos.entryTime) return;

        const { signal, entryPrice, size, tradeId } = pos;
        const { high, low, timestamp } = candle;

        // ❌ FIX #6: Calculate liquidation price
        const liquidationPrice = this.calculateLiquidationPrice(
            entryPrice,
            signal.direction
        );

        let exitPrice: number | null = null;
        let exitReason = '';

        if (signal.direction === TradeDirection.LONG) {
            // Check worst-case first: Liquidation > Stop Loss > Take Profit
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
            // SHORT: Check worst-case first
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
        // Liquidation = entry * (1 - 1/leverage + maintenance) for LONG
        // Liquidation = entry * (1 + 1/leverage - maintenance) for SHORT
        if (direction === TradeDirection.LONG) {
            return entryPrice * (1 - (1 / this.LEVERAGE) + this.MAINTENANCE_MARGIN);
        } else {
            return entryPrice * (1 + (1 / this.LEVERAGE) - this.MAINTENANCE_MARGIN);
        }
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

        // Slippage on exit
        if (signal.direction === TradeDirection.LONG) {
            exitPrice = exitPrice * (1 - this.SLIPPAGE);
        } else {
            exitPrice = exitPrice * (1 + this.SLIPPAGE);
        }

        // Расчет PnL
        const rawPnl = signal.direction === TradeDirection.LONG
            ? (exitPrice - entryPrice) * size
            : (entryPrice - exitPrice) * size;

        // ❌ FIX #5: Exit fee only (entry fee already deducted)
        const exitVol = exitPrice * size;
        const exitFee = reason.includes('Stop') || reason === 'LIQUIDATED'
            ? exitVol * this.TAKER_FEE
            : exitVol * this.MAKER_FEE;

        // Deduct exit fee
        this.portfolio.deductFee(exitFee);

        const totalFee = entryFee + exitFee;
        const netPnl = rawPnl - totalFee;

        // Сохраняем в БД
        await this.tradeRepo.closeTrade(tradeId, exitPrice, timestamp, reason);

        // Обновляем портфель (PnL without fees - fees already deducted)
        this.portfolio.applyTradeResult({ pnl: rawPnl, fees: totalFee, netPnl });

        // Удаляем позицию
        this.activePositions.delete(symbol);

        const dateStr = new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19);
        const color = (reason.includes('Stop') || reason === 'LIQUIDATED') ? '\x1b[31m' : (reason.includes('Profit') ? '\x1b[32m' : '');
        const reset = color ? '\x1b[0m' : '';

        this.logger.info(
            `${color}[${dateStr}] 🏁[EXECUTION] Exit ${signal.direction} @ ${exitPrice.toFixed(2)} ` +
            `(${reason}) | Net PnL: ${netPnl.toFixed(2)} | Fees: ${totalFee.toFixed(4)}${reset}`
        );
    }

    // ❌ FIX #8: Use last known candle price
    private getCurrentPrice(symbol: string): number {
        const candle = this.lastCandles.get(symbol);
        return candle ? candle.close : 0;
    }
}