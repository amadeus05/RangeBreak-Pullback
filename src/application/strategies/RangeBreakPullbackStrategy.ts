import { injectable, inject } from 'inversify';
import { IIndicatorEngine } from '../../domain/interfaces/IIndicatorEngine';
import { IMarketRegimeFilter } from '../../domain/interfaces/IMarketRegimeFilter';
import { IRangeDetector } from '../../domain/interfaces/IRangeDetector';
import { IBreakoutDetector } from '../../domain/interfaces/IBreakoutDetector';
import { IPullbackValidator } from '../../domain/interfaces/IPullbackValidator';
import { IStateMachine } from '../../domain/interfaces/IStateMachine';
import { Candle } from '../../domain/entities/Candle';
import { MarketRange } from '../../domain/value-objects/MarketRange';
import { BreakoutSignal } from '../../domain/value-objects/BreakoutSignal';
import { TradingSignal } from '../../domain/value-objects/TradingSignal';
import { StrategyState } from '../../domain/enums/StrategyState';
import { TradeDirection } from '../../domain/enums/TradeDirection';
import { TYPES } from '../../config/types';
import { Logger } from '../../shared/logger/Logger';

interface StrategyContext {
    range: MarketRange | null;
    breakout: BreakoutSignal | null;
    lastProcessedBar5m: number;
    stateEnterTimestamp: number;
    indicators: {
        atr: number;
        adx: number;
        volumeSMA: number;
    };
}

@injectable()
export class RangeBreakPullbackStrategy {
    private logger = Logger.getInstance();
    private ctx: StrategyContext = this.getDefaultContext();

    constructor(
        @inject(TYPES.IIndicatorEngine) private readonly indicatorEngine: IIndicatorEngine,
        @inject(TYPES.IMarketRegimeFilter) private readonly marketFilter: IMarketRegimeFilter,
        @inject(TYPES.IRangeDetector) private readonly rangeDetector: IRangeDetector,
        @inject(TYPES.IBreakoutDetector) private readonly breakoutDetector: IBreakoutDetector,
        @inject(TYPES.IPullbackValidator) private readonly pullbackValidator: IPullbackValidator,
        @inject(TYPES.IStateMachine) private readonly stateMachine: IStateMachine
    ) {}

    private getDefaultContext(): StrategyContext {
        return {
            range: null,
            breakout: null,
            lastProcessedBar5m: 0,
            stateEnterTimestamp: 0,
            indicators: { atr: 0, adx: 0, volumeSMA: 0 }
        };
    }

    // ═══════════════════════════════════════════
    // ГЛАВНЫЙ МЕТОД: генерация сигнала
    // ═══════════════════════════════════════════
    generateSignal(
        symbol: string,
        candles5m: Candle[],
        candles1m: Candle[]
    ): TradingSignal | null {
        const last5m = candles5m[candles5m.length - 1];
        const last1m = candles1m[candles1m.length - 1];

        // Таймауты
        this.checkTimeouts(last1m.timestamp);

        // 5m логика (обновляем контекст)
        if (last5m.timestamp > this.ctx.lastProcessedBar5m) {
            this.handleHighTimeframeLogic(candles5m);
            this.ctx.lastProcessedBar5m = last5m.timestamp;
        }

        // 1m логика (генерируем сигнал)
        return this.handleLowTimeframeLogic(symbol, candles1m);
    }

    // ═══════════════════════════════════════════
    // ТАЙМАУТЫ
    // ═══════════════════════════════════════════
    private checkTimeouts(currentTimestamp: number): void {
        const state = this.stateMachine.getCurrentState();
        if (state === StrategyState.IDLE || this.ctx.stateEnterTimestamp === 0) return;

        const timeDiff = currentTimestamp - this.ctx.stateEnterTimestamp;

        if (state === StrategyState.WAIT_PULLBACK && timeDiff > 120 * 60 * 1000) {
            this.forceReset(`Pullback timeout (${(timeDiff / 60000).toFixed(0)} min expired)`);
        }
    }

    // ═══════════════════════════════════════════
    // 5m ЛОГИКА (HTF)
    // ═══════════════════════════════════════════
    private handleHighTimeframeLogic(candles5m: Candle[]): void {
        const state = this.stateMachine.getCurrentState();

        if (state !== StrategyState.IDLE && state !== StrategyState.RANGE_DEFINED) return;

        // IDLE: ищем рендж
        if (state === StrategyState.IDLE) {
            if (!this.marketFilter.isMarketValid(candles5m)) return;

            const range = this.rangeDetector.detectRange(candles5m);
            const atr = this.indicatorEngine.calculateATR(candles5m, 14);

            if (range && this.rangeDetector.isRangeValid(range, atr)) {
                this.ctx.range = range;
                this.ctx.indicators.atr = atr;

                this.stateMachine.transition(StrategyState.RANGE_DEFINED, 'Range Frozen');
                this.ctx.stateEnterTimestamp = candles5m[candles5m.length - 1].timestamp;
            }
            return;
        }

        // RANGE_DEFINED: ищем пробой
        if (state === StrategyState.RANGE_DEFINED) {
            if (!this.ctx.range) return;

            const last5m = candles5m[candles5m.length - 1];
            const volumeSMA = this.indicatorEngine.calculateSMA(
                candles5m.map(c => c.volume),
                20
            );

            const breakout = this.breakoutDetector.detectBreakout(
                last5m,
                this.ctx.range,
                this.ctx.indicators.atr,
                volumeSMA
            );

            if (breakout) {
                // Фильтр EMA 200
                const ema200 = this.indicatorEngine.calculateEMA(candles5m, 200);
                const isBullish = last5m.close > ema200;
                const isBearish = last5m.close < ema200;

                if (breakout.direction === TradeDirection.LONG && !isBullish) return;
                if (breakout.direction === TradeDirection.SHORT && !isBearish) return;

                this.ctx.breakout = breakout;
                this.ctx.indicators.volumeSMA = volumeSMA;

                this.stateMachine.transition(StrategyState.BREAKOUT_DETECTED, 'Breakout Confirmed');
                this.stateMachine.transition(StrategyState.WAIT_PULLBACK, 'Waiting for pullback');
                this.ctx.stateEnterTimestamp = last5m.timestamp;
            }
        }
    }

    // ═══════════════════════════════════════════
    // 1m ЛОГИКА (LTF)
    // ═══════════════════════════════════════════
    private handleLowTimeframeLogic(
        symbol: string,
        candles1m: Candle[]
    ): TradingSignal | null {
        const state = this.stateMachine.getCurrentState();
        const last1m = candles1m[candles1m.length - 1];

        if (state !== StrategyState.WAIT_PULLBACK) return null;
        if (!this.ctx.breakout || !this.ctx.range) return null;

        const vwap = this.indicatorEngine.calculateVWAP(candles1m);

        const pullbackValid = this.pullbackValidator.isPullbackValid(
            candles1m,
            this.ctx.breakout,
            this.ctx.range,
            vwap
        );

        if (!pullbackValid) return null;

        // Генерируем лимит-ордер
        return this.createLimitSignal(symbol, last1m, vwap);
    }

    // ═══════════════════════════════════════════
    // СОЗДАНИЕ СИГНАЛА
    // ═══════════════════════════════════════════
    private createLimitSignal(
        symbol: string,
        triggerCandle: Candle,
        vwap: number
    ): TradingSignal {
        if (!this.ctx.breakout || !this.ctx.range) {
            throw new Error('Cannot create signal without breakout/range');
        }

        const direction = this.ctx.breakout.direction;

        // Лимит-цена
        let limitPrice: number;
        if (direction === TradeDirection.LONG) {
            const targetLevel = Math.max(this.ctx.range.high, vwap);
            limitPrice = targetLevel * 0.998;
        } else {
            const targetLevel = Math.min(this.ctx.range.low, vwap);
            limitPrice = targetLevel * 1.002;
        }

        // Стоп-лосс
        const atrBuffer = this.ctx.indicators.atr * 0.4;
        const MIN_STOP_PERCENT = 0.005;

        let stopLoss: number;
        let stopDistance: number;

        if (direction === TradeDirection.LONG) {
            stopLoss = limitPrice - atrBuffer;
            stopDistance = limitPrice - stopLoss;

            const minStopDistance = limitPrice * MIN_STOP_PERCENT;
            if (stopDistance < minStopDistance) {
                stopDistance = minStopDistance;
                stopLoss = limitPrice - stopDistance;
            }
        } else {
            stopLoss = limitPrice + atrBuffer;
            stopDistance = stopLoss - limitPrice;

            const minStopDistance = limitPrice * MIN_STOP_PERCENT;
            if (stopDistance < minStopDistance) {
                stopDistance = minStopDistance;
                stopLoss = limitPrice + stopDistance;
            }
        }

        // Тейк-профит
        const RISK_REWARD = 2.5;
        const takeProfit = direction === TradeDirection.LONG
            ? limitPrice + (stopDistance * RISK_REWARD)
            : limitPrice - (stopDistance * RISK_REWARD);

        // Переходим в новый статус
        this.stateMachine.transition(
            StrategyState.LIMIT_ORDER_PLACED,
            'Limit signal generated'
        );
        this.ctx.stateEnterTimestamp = triggerCandle.timestamp;

        return TradingSignal.createLimitOrder(
            symbol,
            direction,
            limitPrice,
            stopLoss,
            takeProfit,
            triggerCandle.timestamp,
            {
                reason: 'Pullback confirmed',
                rangeHigh: this.ctx.range.high,
                rangeLow: this.ctx.range.low,
                atr: this.ctx.indicators.atr
            }
        );
    }

    // ═══════════════════════════════════════════
    // СБРОС
    // ═══════════════════════════════════════════
    private forceReset(reason: string): void {
        this.ctx = this.getDefaultContext();
        this.stateMachine.reset();
        this.logger.info(`Strategy Reset: ${reason}`);
    }

    reset(): void {
        this.forceReset('Manual reset');
    }
}