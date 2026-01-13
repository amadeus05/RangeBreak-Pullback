import { injectable, inject } from 'inversify';
import { Candle } from '../../domain/entities/Candle';
import { TradingSignal } from '../../domain/value-objects/TradingSignal';
import { MarketRegime, TrendDirection, StrategyState, TradeDirection } from '../../domain/enums';
import { TrendAnalysis, PullbackAnalysis, MomentumSignal } from '../../domain/types/StrategyTypes';
import { RegimeDetector } from '../services/market/RegimeDetector';
import { TrendAnalyzer } from '../services/detection/TrendAnalyzer';
import { PullbackScanner } from '../services/detection/PullbackScanner';
import { MomentumDetector } from '../services/detection/MomentumDetector';
import { IStateMachine } from '../../domain/interfaces/IStateMachine';
import { TYPES } from '../../config/types';
import { Logger } from '../../shared/logger/Logger';

@injectable()
export class TrendContinuationStrategy {
    private logger = Logger.getInstance();
    private currentTrend: TrendAnalysis | null = null;
    private currentPullback: PullbackAnalysis | null = null;
    private lastPullbackTimestamp: number = 0;

    constructor(
        @inject(TYPES.RegimeDetector) private readonly regimeDetector: RegimeDetector,
        @inject(TYPES.TrendAnalyzer) private readonly trendAnalyzer: TrendAnalyzer,
        @inject(TYPES.PullbackScanner) private readonly pullbackScanner: PullbackScanner,
        @inject(TYPES.MomentumDetector) private readonly momentumDetector: MomentumDetector,
        @inject(TYPES.IStateMachine) private readonly stateMachine: IStateMachine
    ) { }

    public generateSignal(
        symbol: string,
        candles5m: Candle[],
        candles1m: Candle[]
    ): TradingSignal | null {
        const lastCandle = candles5m[candles5m.length - 1];
        const state = this.stateMachine.getCurrentState();

        // 1. REGIME FILTER
        const regime = this.regimeDetector.detect(candles5m);

        // 2. TREND QUALIFICATION
        const trend = this.trendAnalyzer.analyze(candles5m, regime);

        const timeStr = this.formatTimestamp(lastCandle.timestamp);
        this.logger.info(`[${timeStr}] Regime: ${regime}, Trend: ${trend.direction}, Strength: ${trend.strength.toFixed(2)}`);

        // 0. RESET LOGIC FOR COMPLETED TRADES / TIMEOUTS
        if (state === StrategyState.LIMIT_ORDER_PLACED || state === StrategyState.IN_POSITION) {
            // If trend reverses while in position or waiting, we might want to reset the state machine
            // to be ready for the next setup once this one is done.
            // For now, let's just reset if trend direction changes or strength drops significantly.
            if (trend.direction === TrendDirection.NEUTRAL || !trend.isStrong) {
                this.reset('Trend lost during/after entry', lastCandle.timestamp);
            }
            // Also reset if we've been in this state too long (e.g. 4 hours)
            if (this.stateMachine.getTimeInState() > 4 * 60 * 60 * 1000) {
                this.reset('State timeout', lastCandle.timestamp);
            }
            return null;
        }

        if (regime !== MarketRegime.TRENDING) {
            if (state !== StrategyState.IDLE) {
                this.reset('Regime changed (no longer Trending)', lastCandle.timestamp);
            }
            return null;
        }

        // 2. TREND QUALIFICATION
        if (!trend.isStrong || trend.direction === TrendDirection.NEUTRAL) {
            if (state !== StrategyState.IDLE) {
                this.reset('Trend no longer strong', lastCandle.timestamp);
            }
            return null;
        }

        // 3. PULLBACK LOGIC
        if (state === StrategyState.IDLE) {
            const pullback = this.pullbackScanner.scan(candles5m, trend);
            const timeStr = this.formatTimestamp(lastCandle.timestamp);
            this.logger.info(`[${timeStr}] Pullback: ${pullback.isValid} (Level: ${pullback.level.toFixed(2)})`);

            if (pullback.isValid && !this.pullbackScanner.isTooDeep(pullback, trend)) {
                this.currentTrend = trend;
                this.currentPullback = pullback;
                this.lastPullbackTimestamp = lastCandle.timestamp;
                this.stateMachine.transition(StrategyState.WAIT_PULLBACK, 'Valid Pullback Detected');
            }
            return null;
        }

        // 4. ENTRY TRIGGER (WAIT_PULLBACK -> WAIT_MOMENTUM/ENTRY)
        if (state === StrategyState.WAIT_PULLBACK) {
            // Re-validate pullback and trend
            if (this.currentTrend?.direction !== trend.direction) {
                this.reset('Trend direction changed during pullback', lastCandle.timestamp);
                return null;
            }

            const momentum = this.momentumDetector.detect(candles5m);
            const timeStr = this.formatTimestamp(lastCandle.timestamp);
            this.logger.info(`[${timeStr}] Momentum spike: ${momentum.hasSpike}, Direction: ${momentum.direction}`);

            // Momentum must align with trend direction
            const momentumAligns =
                (trend.direction === TrendDirection.BULLISH && momentum.direction === TrendDirection.BULLISH) ||
                (trend.direction === TrendDirection.BEARISH && momentum.direction === TrendDirection.BEARISH);

            if (momentum.hasSpike && momentumAligns) {
                return this.createSignal(symbol, lastCandle, trend, momentum);
            }

            // Check if pullback became too deep
            const currentPullback = this.pullbackScanner.scan(candles5m, trend);
            if (this.pullbackScanner.isTooDeep(currentPullback, trend)) {
                this.reset('Pullback too deep (potential reversal)', lastCandle.timestamp);
                return null;
            }
        }

        return null;
    }

    private createSignal(
        symbol: string,
        candle: Candle,
        trend: TrendAnalysis,
        momentum: MomentumSignal
    ): TradingSignal {
        const direction = trend.direction === TrendDirection.BULLISH ? TradeDirection.LONG : TradeDirection.SHORT;

        // STOP LOSS: below pullback structure or 0.8 x ATR
        const atr = momentum.atr;
        const pullbackLevel = this.currentPullback?.level || candle.close;
        const atrStop = direction === TradeDirection.LONG
            ? candle.close - (0.8 * atr)
            : candle.close + (0.8 * atr);

        const stopLoss = direction === TradeDirection.LONG
            ? Math.min(pullbackLevel, atrStop)
            : Math.max(pullbackLevel, atrStop);

        const risk = Math.abs(candle.close - stopLoss);

        // TAKE PROFIT: minimum 2R
        const takeProfit = direction === TradeDirection.LONG
            ? candle.close + (risk * 2)
            : candle.close - (risk * 2);

        this.stateMachine.transition(StrategyState.LIMIT_ORDER_PLACED, 'Momentum Triggered Entry');

        return TradingSignal.createMarketOrder(
            symbol,
            direction,
            candle.close,
            stopLoss,
            takeProfit,
            candle.timestamp,
            {
                reason: 'Trend pullback with momentum spike',
                trendStrength: trend.strength,
                momentumScore: this.momentumDetector.calculateMomentumScore(momentum)
            }
        );
    }

    private reset(reason: string, timestamp?: number): void {
        this.currentTrend = null;
        this.currentPullback = null;
        this.stateMachine.reset();

        const timeStr = timestamp ? `[${this.formatTimestamp(timestamp)}] ` : '';
        this.logger.info(`${timeStr}Strategy Reset: ${reason}`);
    }

    public resetManual(): void {
        this.reset('Manual reset');
    }

    private formatTimestamp(timestamp: number): string {
        const date = new Date(timestamp);
        // Format: YYYY-MM-DD HH:mm:ss
        return date.toISOString().replace('T', ' ').substring(0, 19);
    }
}
