import { injectable, inject } from 'inversify';
import { IExchange } from '../../domain/interfaces/IExchange';
import { IIndicatorEngine } from '../../domain/interfaces/IIndicatorEngine';
import { IMarketRegimeFilter } from '../../domain/interfaces/IMarketRegimeFilter';
import { IRangeDetector } from '../../domain/interfaces/IRangeDetector';
import { IBreakoutDetector } from '../../domain/interfaces/IBreakoutDetector';
import { IPullbackValidator } from '../../domain/interfaces/IPullbackValidator';
import { IRiskEngine } from '../../domain/interfaces/IRiskEngine';
import { IStateMachine } from '../../domain/interfaces/IStateMachine';
import { Candle } from '../../domain/entities/Candle';
import { MarketRange } from '../../domain/value-objects/MarketRange';
import { BreakoutSignal } from '../../domain/value-objects/BreakoutSignal';
import { StrategyState } from '../../domain/enums/StrategyState';
import { TradeDirection } from '../../domain/enums/TradeDirection';
import { TYPES } from '../../config/types';
import { Logger } from '../../shared/logger/Logger';
import { TradeRepository } from '../../infrastructure/database/repositories/TradeRepository';

interface StrategyContext {
    range: MarketRange | null;
    breakout: BreakoutSignal | null;
    lastProcessedBar5m: number;
    // ВАЖНО: Время входа в текущий статус (по свечам)
    stateEnterTimestamp: number; 
    indicators: {
        atr: number;
        adx: number;
        volumeSMA: number;
    };
    activeTradeId: number | null;
    tradeParams: {
        entryPrice: number;
        stopLoss: number;
        takeProfit: number;
        size: number;
        direction: TradeDirection;
    } | null;
}

@injectable()
export class RangeBreakPullbackStrategy {
    private logger = Logger.getInstance();
    private ctx: StrategyContext = this.getDefaultContext();
    
    private dailyLoss: number = 0;
    private consecutiveLosses: number = 0;
    
    // Риск-параметры
    private readonly MAX_DAILY_LOSS_PERCENT = 0.10; // 10%
    private readonly MAX_CONSECUTIVE_LOSSES = 10;   // 10 подряд
    private lastDayProcessed: number = -1;

    // Честный бектест
    private readonly TRADING_FEE = 0.00055;
    private readonly SLIPPAGE = 0.0001;     

    constructor(
        @inject(TYPES.IExchange) private readonly exchange: IExchange,
        @inject(TYPES.IIndicatorEngine) private readonly indicatorEngine: IIndicatorEngine,
        @inject(TYPES.IMarketRegimeFilter) private readonly marketFilter: IMarketRegimeFilter,
        @inject(TYPES.IRangeDetector) private readonly rangeDetector: IRangeDetector,
        @inject(TYPES.IBreakoutDetector) private readonly breakoutDetector: IBreakoutDetector,
        @inject(TYPES.IPullbackValidator) private readonly pullbackValidator: IPullbackValidator,
        @inject(TYPES.IRiskEngine) private readonly riskEngine: IRiskEngine,
        @inject(TYPES.IStateMachine) private readonly stateMachine: IStateMachine,
        @inject(TradeRepository) private readonly tradeRepo: TradeRepository
    ) {}

    private getDefaultContext(): StrategyContext {
        return {
            range: null,
            breakout: null,
            lastProcessedBar5m: 0,
            stateEnterTimestamp: 0, // Инициализация
            indicators: { atr: 0, adx: 0, volumeSMA: 0 },
            activeTradeId: null,
            tradeParams: null
        };
    }

    async processTick(symbol: string, candles5m: Candle[], candles1m: Candle[], balance: number): Promise<void> {
        const last5m = candles5m[candles5m.length - 1];
        const last1m = candles1m[candles1m.length - 1];

        // --- NEW DAY RESET ---
        const currentDay = new Date(last5m.timestamp).getUTCDate();
        if (currentDay !== this.lastDayProcessed) {
            if (this.lastDayProcessed !== -1) {
                this.dailyLoss = 0; 
                this.consecutiveLosses = 0;
            }
            this.lastDayProcessed = currentDay;
        }

        // 1. KILL SWITCH
        if (this.dailyLoss / balance >= this.MAX_DAILY_LOSS_PERCENT || 
            this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
            return;
        }

        const currentState = this.stateMachine.getCurrentState();

        // 2. ТАЙМАУТЫ (Теперь передаем время свечи!)
        this.checkTimeouts(last1m.timestamp);

        // 3. УПРАВЛЕНИЕ ПОЗИЦИЕЙ
        if (currentState === StrategyState.IN_POSITION) {
            await this.managePosition(last1m);
            return; 
        }

        // 4. 5m ЛОГИКА
        if (last5m.timestamp > this.ctx.lastProcessedBar5m) {
            await this.handleHighTimeframeLogic(candles5m);
            this.ctx.lastProcessedBar5m = last5m.timestamp;
        }

        // 5. 1m ЛОГИКА
        await this.handleLowTimeframeLogic(candles1m, balance);
    }

    // ИСПРАВЛЕННЫЙ МЕТОД ТАЙМАУТОВ
    private checkTimeouts(currentTimestamp: number): void {
        const state = this.stateMachine.getCurrentState();
        if (state === StrategyState.IDLE) return;

        // Если время входа не записано, выходим
        if (this.ctx.stateEnterTimestamp === 0) return;

        const timeDiff = currentTimestamp - this.ctx.stateEnterTimestamp;

        // Если ждем откат больше 2 часов (120 минут * 60 * 1000)
        // Увеличил до 2 часов, чтобы дать шанс
        if (state === StrategyState.WAIT_PULLBACK && timeDiff > 120 * 60 * 1000) {
            this.forceReset(`Pullback timeout (${(timeDiff/60000).toFixed(0)} min expired)`);
        }
        
        // Если сделка висит больше 24 часов — закрываем принудительно (опционально)
        // Здесь пока просто варнинг
        if (state === StrategyState.IN_POSITION && timeDiff > 24 * 60 * 60 * 1000) {
             // this.forceExit(...) // можно реализовать позже
        }
    }

    private async handleHighTimeframeLogic(candles5m: Candle[]): Promise<void> {
        const state = this.stateMachine.getCurrentState();

        if (state !== StrategyState.IDLE && state !== StrategyState.RANGE_DEFINED) return;

        // --- IDLE: ИЩЕМ РЕНДЖ ---
        if (state === StrategyState.IDLE) {
            if (!this.marketFilter.isMarketValid(candles5m)) return;

            const range = this.rangeDetector.detectRange(candles5m);
            const atr = this.indicatorEngine.calculateATR(candles5m, 14);
            
            if (range && this.rangeDetector.isRangeValid(range, atr)) {
                this.ctx.range = range;
                this.ctx.indicators.atr = atr;
                this.logStateSnapshot(StrategyState.RANGE_DEFINED, 'New Range Found');
                
                this.stateMachine.transition(StrategyState.RANGE_DEFINED, 'Range Frozen');
                // Запоминаем время перехода
                this.ctx.stateEnterTimestamp = candles5m[candles5m.length - 1].timestamp;
            }
            return;
        }

        // --- RANGE: ИЩЕМ ПРОБОЙ ---
        if (state === StrategyState.RANGE_DEFINED) {
            if (!this.ctx.range) return;

            const last5m = candles5m[candles5m.length - 1];
            const volumeSMA = this.indicatorEngine.calculateSMA(candles5m.map(c => c.volume), 20);
            
            const breakout = this.breakoutDetector.detectBreakout(
                last5m, 
                this.ctx.range, 
                this.ctx.indicators.atr, 
                volumeSMA
            );
            
            if (breakout) {
                // Фильтр EMA 200 (Трендовый)
                const ema200 = this.indicatorEngine.calculateEMA(candles5m, 200);
                const isBullish = last5m.close > ema200;
                const isBearish = last5m.close < ema200;

                if (breakout.direction === TradeDirection.LONG && !isBullish) return;
                if (breakout.direction === TradeDirection.SHORT && !isBearish) return;

                this.ctx.breakout = breakout;
                this.ctx.indicators.volumeSMA = volumeSMA;
                this.logStateSnapshot(StrategyState.BREAKOUT_DETECTED, 'Breakout Confirmed');
                
                this.stateMachine.transition(StrategyState.BREAKOUT_DETECTED, '5m Breakout Confirmed');
                
                // СРАЗУ ПЕРЕХОДИМ В ОЖИДАНИЕ ОТКАТА
                this.stateMachine.transition(StrategyState.WAIT_PULLBACK, 'Handing over to 1m');
                
                // ВАЖНО: Запоминаем время начала ожидания отката!
                this.ctx.stateEnterTimestamp = last5m.timestamp;
            }
        }
    }

    private async handleLowTimeframeLogic(candles1m: Candle[], balance: number): Promise<void> {
        if (this.stateMachine.getCurrentState() !== StrategyState.WAIT_PULLBACK) return;

        const vwap = this.indicatorEngine.calculateVWAP(candles1m);
        const last1m = candles1m[candles1m.length - 1];

        const pullbackValid = this.pullbackValidator.isPullbackValid(
            candles1m,
            this.ctx.breakout!,
            this.ctx.range!,
            vwap
        );

        // Входим при касании зоны (Touch Trade)
        if (pullbackValid) {
            this.logStateSnapshot(StrategyState.ENTRY_PLACED, 'Pullback Zone Hit');
            this.stateMachine.transition(StrategyState.ENTRY_PLACED, 'Touch trade');
            
            await this.executeEntry(last1m, balance);
        }
    }

    private async executeEntry(triggerCandle: Candle, balance: number): Promise<void> {
        if (!this.ctx.breakout) return;

        const direction = this.ctx.breakout.direction;
        let entryPrice = triggerCandle.close;

        // Проскальзывание
        if (direction === TradeDirection.LONG) {
            entryPrice = entryPrice * (1 + this.SLIPPAGE);
        } else {
            entryPrice = entryPrice * (1 - this.SLIPPAGE);
        }
        
        // Стоп и Тейк
        const atrBuffer = this.ctx.indicators.atr * 0.5; 
        const MIN_STOP_PERCENT = 0.005; 
        
        let rawStopLoss = 0;
        if (direction === TradeDirection.LONG) {
            rawStopLoss = triggerCandle.low - atrBuffer;
        } else {
            rawStopLoss = triggerCandle.high + atrBuffer;
        }

        let stopDistance = Math.abs(entryPrice - rawStopLoss);
        const minStopDistance = entryPrice * MIN_STOP_PERCENT;

        if (stopDistance < minStopDistance) {
            stopDistance = minStopDistance;
        }

        let stopLoss = 0;
        let takeProfit = 0;
        const RISK_REWARD = 2.5; 

        if (direction === TradeDirection.LONG) {
            stopLoss = entryPrice - stopDistance;
            takeProfit = entryPrice + (stopDistance * RISK_REWARD);
        } else {
            stopLoss = entryPrice + stopDistance;
            takeProfit = entryPrice - (stopDistance * RISK_REWARD);
        }

        const size = this.riskEngine.calculatePositionSize(balance, stopDistance);

        this.ctx.tradeParams = {
            entryPrice,
            stopLoss,
            takeProfit,
            size,
            direction
        };

        const tradeId = await this.tradeRepo.saveTrade({
            id: 0,
            symbol: triggerCandle.symbol,
            direction,
            entryTime: triggerCandle.timestamp,
            entryPrice,
            size,
            stopLoss,
            takeProfit,
            status: 'OPEN'
        });

        this.ctx.activeTradeId = tradeId;

        const dateStr = new Date(triggerCandle.timestamp).toISOString();
        this.logger.info(`[${dateStr}] [EXECUTION] Entry ${direction} @ ${entryPrice.toFixed(2)} | SL: ${stopLoss.toFixed(2)} | TP: ${takeProfit.toFixed(2)} | Size: ${size.toFixed(4)}`);
        
        this.stateMachine.transition(StrategyState.IN_POSITION, 'Trade executed');
        // Обновляем время входа в статус
        this.ctx.stateEnterTimestamp = triggerCandle.timestamp;
    }

    private async managePosition(currentCandle: Candle): Promise<void> {
        if (!this.ctx.tradeParams || !this.ctx.activeTradeId) return;

        const { stopLoss, takeProfit, direction, entryPrice, size } = this.ctx.tradeParams;
        const { high, low, timestamp } = currentCandle;

        let exitPrice: number | null = null;
        let exitReason = '';

        if (direction === TradeDirection.LONG) {
            if (low <= stopLoss) {
                exitPrice = stopLoss;
                exitReason = 'Stop Loss';
            } else if (high >= takeProfit) {
                exitPrice = takeProfit;
                exitReason = 'Take Profit';
            }
        } else {
            if (high >= stopLoss) {
                exitPrice = stopLoss;
                exitReason = 'Stop Loss';
            } else if (low <= takeProfit) {
                exitPrice = takeProfit;
                exitReason = 'Take Profit';
            }
        }

        if (exitPrice !== null) {
            if (direction === TradeDirection.LONG) {
                exitPrice = exitPrice * (1 - this.SLIPPAGE);
            } else {
                exitPrice = exitPrice * (1 + this.SLIPPAGE);
            }

            await this.tradeRepo.closeTrade(
                this.ctx.activeTradeId,
                exitPrice,
                timestamp,
                exitReason
            );

            const rawPnl = direction === TradeDirection.LONG
                ? (exitPrice - entryPrice) * size
                : (entryPrice - exitPrice) * size;

            const entryVol = entryPrice * size;
            const exitVol = exitPrice * size;
            const totalFee = (entryVol + exitVol) * this.TRADING_FEE;
            const netPnl = rawPnl - totalFee;

            if (netPnl < 0) {
                this.dailyLoss += Math.abs(netPnl);
                this.consecutiveLosses++;
            } else {
                this.consecutiveLosses = 0;
            }

            const dateStr = new Date(timestamp).toISOString();
            this.logger.info(`[${dateStr}] [EXECUTION] Exit ${direction} @ ${exitPrice.toFixed(2)} (${exitReason}) | Net PnL: ${netPnl.toFixed(2)}`);

            this.stateMachine.transition(StrategyState.EXIT, exitReason);
            this.forceReset('Trade Closed');
        }
    }

    private logStateSnapshot(newState: StrategyState, reason: string): void {
        this.logger.info(`[STRATEGY SNAPSHOT] Transition to ${newState} | Reason: ${reason}`);
    }

    private forceReset(reason: string): void {
        this.ctx = this.getDefaultContext(); 
        this.stateMachine.reset();
        this.logger.info(`Strategy Reset: ${reason}`);
    }
}