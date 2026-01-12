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

interface ActivePosition {
    tradeId: number;
    signal: TradingSignal;
    size: number;
    entryPrice: number;
}

@injectable()
export class ExecutionEngine {
    private logger = Logger.getInstance();
    
    private pendingOrders: Map<string, PendingLimitOrder> = new Map();
    private activePositions: Map<string, ActivePosition> = new Map();

    private readonly TRADING_FEE = 0.00055;
    private readonly SLIPPAGE = 0.0001;
    private readonly MAKER_FEE = 0.0002;
    private readonly TAKER_FEE = 0.0005;

    constructor(
        @inject(TYPES.IRiskEngine) private readonly riskEngine: IRiskEngine,
        @inject(PortfolioManager) private readonly portfolio: PortfolioManager,
        @inject(TradeRepository) private readonly tradeRepo: TradeRepository
    ) {}

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

        const size = this.riskEngine.calculatePositionSize(
            this.portfolio.getBalance(),
            signal.stopDistance
        );

        if (signal.orderType === 'LIMIT') {
            this.placeLimitOrder(signal, size);
        } else {
            await this.executeMarketOrder(signal, size);
        }
    }

    // 2. Обработка тика рынка (проверяем лимиты и позиции)
    async onMarketData(candle: Candle): Promise<void> {
        // Проверяем лимитные ордера
        await this.checkLimitOrders(candle);

        // Управляем открытыми позициями
        await this.managePositions(candle);
    }

    // 3. Отмена ордера
    cancelOrder(symbol: string): void {
        if (this.pendingOrders.has(symbol)) {
            this.pendingOrders.delete(symbol);
            this.logger.info(`[EXECUTION] Limit order cancelled for ${symbol}`);
        }
    }

    // 4. Принудительное закрытие
    async forceClosePosition(symbol: string, reason: string): Promise<void> {
        const pos = this.activePositions.get(symbol);
        if (!pos) return;

        // Закрываем по маркету
        const exitPrice = await this.getCurrentPrice(symbol);
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

        const dateStr = new Date(signal.timestamp).toISOString();
        this.logger.info(
            `[${dateStr}] [LIMIT ORDER] Placed ${signal.direction} @ ${signal.price.toFixed(2)} ` +
            `| SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)} | Size: ${size.toFixed(4)}`
        );
    }

    private async checkLimitOrders(candle: Candle): Promise<void> {
        const order = this.pendingOrders.get(candle.symbol);
        if (!order) return;

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

    private async executeMarketOrder(signal: TradingSignal, size: number): Promise<void> {
        let fillPrice = signal.price;

        if (signal.direction === TradeDirection.LONG) {
            fillPrice = fillPrice * (1 + this.SLIPPAGE);
        } else {
            fillPrice = fillPrice * (1 - this.SLIPPAGE);
        }

        await this.openPosition(signal.symbol, signal, size, fillPrice, signal.timestamp);
    }

    private async openPosition(
        symbol: string,
        signal: TradingSignal,
        size: number,
        entryPrice: number,
        timestamp: number
    ): Promise<void> {
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
            entryPrice
        });

        const dateStr = new Date(timestamp).toISOString();
        this.logger.info(
            `[${dateStr}] [EXECUTION] Entry ${signal.direction} @ ${entryPrice.toFixed(2)} ` +
            `| SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)}`
        );
    }

    private async managePositions(candle: Candle): Promise<void> {
        const pos = this.activePositions.get(candle.symbol);
        if (!pos) return;

        const { signal, entryPrice, size, tradeId } = pos;
        const { high, low, timestamp } = candle;

        let exitPrice: number | null = null;
        let exitReason = '';

        if (signal.direction === TradeDirection.LONG) {
            if (low <= signal.stopLoss) {
                exitPrice = signal.stopLoss;
                exitReason = 'Stop Loss';
            } else if (high >= signal.takeProfit) {
                exitPrice = signal.takeProfit;
                exitReason = 'Take Profit';
            }
        } else {
            if (high >= signal.stopLoss) {
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

    private async closePosition(
        symbol: string,
        exitPrice: number,
        timestamp: number,
        reason: string
    ): Promise<void> {
        const pos = this.activePositions.get(symbol);
        if (!pos) return;

        const { signal, entryPrice, size, tradeId } = pos;

        // Slippage
        if (signal.direction === TradeDirection.LONG) {
            exitPrice = exitPrice * (1 - this.SLIPPAGE);
        } else {
            exitPrice = exitPrice * (1 + this.SLIPPAGE);
        }

        // Расчет PnL
        const rawPnl = signal.direction === TradeDirection.LONG
            ? (exitPrice - entryPrice) * size
            : (entryPrice - exitPrice) * size;

        // Комиссии
        const entryVol = entryPrice * size;
        const exitVol = exitPrice * size;
        const entryFee = entryVol * this.TAKER_FEE;
        const exitFee = reason.includes('Stop') 
            ? exitVol * this.TAKER_FEE 
            : exitVol * this.MAKER_FEE;
        const totalFee = entryFee + exitFee;
        const netPnl = rawPnl - totalFee;

        // Сохраняем в БД
        await this.tradeRepo.closeTrade(tradeId, exitPrice, timestamp, reason);

        // Обновляем портфель
        this.portfolio.applyTradeResult({ pnl: rawPnl, fees: totalFee, netPnl });

        // Удаляем позицию
        this.activePositions.delete(symbol);

        const dateStr = new Date(timestamp).toISOString();
        this.logger.info(
            `[${dateStr}] [EXECUTION] Exit ${signal.direction} @ ${exitPrice.toFixed(2)} ` +
            `(${reason}) | Net PnL: ${netPnl.toFixed(2)}`
        );
    }

    private async getCurrentPrice(symbol: string): Promise<number> {
        // We can't easily reach the simulation candle from here without passing it.
        // For now, find the active position and return entry price as fallback 
        // to avoid division by zero or NaN, though ideally this should 
        // be passed the current candle.
        const pos = this.activePositions.get(symbol);
        return pos ? pos.entryPrice : 0;
    }
}