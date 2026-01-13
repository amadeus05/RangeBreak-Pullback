/**
 * Momentum Strategy (Stateful Momentum Pullback v5.0 - Conservative)
 * Transferred from source bot
 */

import { injectable, inject } from 'inversify';
import { Candle } from '../../domain/entities/Candle';
import { TradingSignal } from '../../domain/value-objects/TradingSignal';
import { MarketRegime, TrendDirection, TradeDirection } from '../../domain/enums';
import { PullbackAnalysis } from '../../domain/types/StrategyTypes';
import { TrendAnalyzer } from '../services/detection/TrendAnalyzer';
import { MomentumDetector } from '../services/detection/MomentumDetector';
import { PullbackScanner } from '../services/detection/PullbackScanner';
import { RegimeDetector } from '../services/market/RegimeDetector';
import { TYPES } from '../../config/types';
import { Logger } from '../../shared/logger/Logger';

enum SetupState {
    IDLE,
    WAITING_PULLBACK,
    PULLBACK_CONFIRMED,
    READY_TO_ENTER,
    ENTERED,
    INVALIDATED
}

interface MomentumSetup {
    state: SetupState;
    direction: TrendDirection;
    impulseHigh: number;
    impulseLow: number;
    impulseATR: number;
    impulseVolumeRatio: number;
    barsSinceImpulse: number;
    pullbackHigh?: number;
    pullbackLow?: number;
    pullbackDepth?: number;
    pullback?: PullbackAnalysis;
}

@injectable()
export class MomentumStrategy {
    private setups: Map<string, MomentumSetup> = new Map();
    private logger = Logger.getInstance();
    private analyzeCallCount: Map<string, number> = new Map();

    constructor(
        @inject(TYPES.TrendAnalyzer) private readonly trendAnalyzer: TrendAnalyzer,
        @inject(TYPES.MomentumDetector) private readonly momentumDetector: MomentumDetector,
        @inject(TYPES.PullbackScanner) private readonly pullbackScanner: PullbackScanner,
        @inject(TYPES.RegimeDetector) private readonly regimeDetector: RegimeDetector
    ) {
        this.logger.info('StrategyEngine', 'Initialized (Stateful Momentum Pullback v5.0 - Conservative)');
    }

    public analyze(symbol: string, candles: Candle[]): TradingSignal | null {
        // Increment call counter for this symbol
        const callCount = (this.analyzeCallCount.get(symbol) || 0) + 1;
        this.analyzeCallCount.set(symbol, callCount);

        const last = candles[candles.length - 1];

        let setup = this.setups.get(symbol);
        if (!setup) {
            this.resetSetup(symbol);
            setup = this.setups.get(symbol)!;
            this.info(symbol, '🆕 NEW SETUP CREATED (IDLE)');
        }

        // === 1. STRICT REGIME FILTER ===
        const regime = this.regimeDetector.detect(candles);
        const isTrending = this.regimeDetector.isTrendingRegime(regime);

        // DEBUG: Log every 5000 calls
        const shouldLog = callCount % 5000 === 0;
        if (shouldLog) {
            this.info(symbol, `📊 DEBUG [${callCount}]: regime=${regime}, isTrending=${isTrending}`);
        }

        if (!isTrending) {
            if (setup.state === SetupState.IDLE) return null;
            return this.invalidate(symbol, `REGIME_NOT_TRENDING:${regime}`);
        }

        const trend = this.trendAnalyzer.analyze(candles);

        switch (setup.state) {
            case SetupState.IDLE: {
                if (shouldLog) {
                    this.info(symbol, `📊 DEBUG IDLE [${callCount}]: trend.isStrong=${trend.isStrong}, strength=${trend.strength.toFixed(2)}, dir=${trend.direction}`);
                }

                if (!trend.isStrong || trend.direction === TrendDirection.NEUTRAL) {
                    if (shouldLog) this.debug(symbol, `⏸️ Trend not strong enough`);
                    return null;
                }

                const momentum = this.momentumDetector.detect(candles);
                if (shouldLog) {
                    this.info(symbol, `📊 DEBUG: momentum.hasSpike=${momentum.hasSpike}, volumeRatio=${momentum.volumeRatio.toFixed(2)}, dir=${momentum.direction}`);
                }

                if (!momentum.hasSpike) {
                    if (shouldLog) this.debug(symbol, `⏸️ No momentum spike`);
                    return null;
                }
                if (momentum.direction !== trend.direction) {
                    if (shouldLog) this.debug(symbol, `⏸️ Momentum direction mismatch`);
                    return null;
                }

                // Volume filter: only enter if impulse volume was noticeable (>1.2x)
                if (momentum.volumeRatio < 1.2) {
                    if (shouldLog) this.debug(symbol, `⏸️ Volume ratio too low: ${momentum.volumeRatio.toFixed(2)}`);
                    return null;
                }

                setup.state = SetupState.WAITING_PULLBACK;
                setup.direction = trend.direction;
                setup.impulseHigh = momentum.high;
                setup.impulseLow = momentum.low;
                setup.impulseATR = momentum.atr;
                setup.impulseVolumeRatio = momentum.volumeRatio;
                setup.barsSinceImpulse = 0;

                this.info(symbol, '🔥 IMPULSE DETECTED → WAITING_PULLBACK', {
                    dir: setup.direction,
                    vol: setup.impulseVolumeRatio.toFixed(2)
                });
                return null;
            }

            case SetupState.WAITING_PULLBACK: {
                setup.barsSinceImpulse++;

                // Timeout 50 bars
                if (setup.barsSinceImpulse > 50) {
                    this.info(symbol, `⏱️ TIMEOUT after 50 bars`);
                    return this.invalidate(symbol, 'TIMEOUT');
                }

                // Structural Break
                if (setup.direction === TrendDirection.BULLISH && last.low < setup.impulseLow)
                    return this.invalidate(symbol, 'IMPULSE LOW BROKEN');
                if (setup.direction === TrendDirection.BEARISH && last.high > setup.impulseHigh)
                    return this.invalidate(symbol, 'IMPULSE HIGH BROKEN');

                const pullback = this.pullbackScanner.scan(candles, trend);
                if (!pullback.occurred) return null;
                if (!pullback.isValid) return null;

                // Sanity checks
                if (!Number.isFinite(pullback.level) || !Number.isFinite(pullback.low) || !Number.isFinite(pullback.high)) {
                    return this.invalidate(symbol, 'BAD_PULLBACK_NUMBERS');
                }

                const isLong = setup.direction === TrendDirection.BULLISH;
                const impulseRange = setup.impulseHigh - setup.impulseLow;

                if (!Number.isFinite(impulseRange) || impulseRange <= 0) {
                    return this.invalidate(symbol, 'BAD_IMPULSE_RANGE');
                }

                let currentPullbackDist = isLong
                    ? setup.impulseHigh - pullback.level
                    : pullback.level - setup.impulseLow;

                const fibLevel = currentPullbackDist / impulseRange;
                if (!Number.isFinite(fibLevel)) {
                    return this.invalidate(symbol, 'BAD_FIB_LEVEL');
                }

                // FILTER: 30% - 70% Fib
                if (fibLevel < 0.3 || fibLevel > 0.7) return null;

                setup.pullbackLow = pullback.low;
                setup.pullbackHigh = pullback.high;
                setup.pullbackDepth = pullback.distanceFromEMA / 100;
                setup.pullback = pullback;
                setup.state = SetupState.PULLBACK_CONFIRMED;

                this.info(symbol, `🟢 PULLBACK CONFIRMED (Fib: ${fibLevel.toFixed(2)}) → checking bounce`, setup);
                return null;
            }

            case SetupState.PULLBACK_CONFIRMED: {
                if (!setup.pullback) return this.invalidate(symbol, 'PULLBACK_MISSING');

                const bouncing = this.pullbackScanner.isBouncing(candles, setup.pullback, setup.direction);

                if (!bouncing) {
                    const isLong = setup.direction === TrendDirection.BULLISH;
                    if (isLong && last.close < setup.pullbackLow!) return this.invalidate(symbol, 'LOWER LOW');
                    if (!isLong && last.close > setup.pullbackHigh!) return this.invalidate(symbol, 'HIGHER HIGH');
                    return null;
                }

                setup.state = SetupState.READY_TO_ENTER;
                return null;
            }

            case SetupState.READY_TO_ENTER: {
                const signal = this.generateSignal(symbol, candles, setup);
                setup.state = SetupState.ENTERED;
                this.info(symbol, '🎯🎯🎯 TRADE SIGNAL EMITTED!', signal);
                return signal;
            }

            case SetupState.ENTERED:
                this.resetSetup(symbol);
                return null;

            case SetupState.INVALIDATED:
                this.resetSetup(symbol);
                return null;
        }
    }

    private generateSignal(symbol: string, candles: Candle[], setup: MomentumSetup): TradingSignal {
        const isLong = setup.direction === TrendDirection.BULLISH;
        const last = candles[candles.length - 1];

        // Entry with minimal buffer
        const entryBuffer = setup.impulseATR * 0.05;
        const entry = isLong
            ? setup.pullbackHigh! + entryBuffer
            : setup.pullbackLow! - entryBuffer;

        const impulseRange = setup.impulseHigh - setup.impulseLow;

        // STOP LOSS: 2.0 ATR
        const atrBuffer = setup.impulseATR * 2.0;
        const stopLoss = isLong
            ? setup.pullbackLow! - atrBuffer
            : setup.pullbackHigh! + atrBuffer;

        // TAKE PROFIT: max(ImpulseRange, 3 ATR)
        const targetDist = Math.max(impulseRange, setup.impulseATR * 3.0);
        const takeProfit = isLong
            ? entry + targetDist
            : entry - targetDist;

        const confidence = this.calculateConfidence(candles, setup);
        const direction = isLong ? TradeDirection.LONG : TradeDirection.SHORT;

        return TradingSignal.createMarketOrder(
            symbol,
            direction,
            entry,
            stopLoss,
            takeProfit,
            last.timestamp,
            {
                reason: 'momentum_pullback',
                confidence,
                volumeRatio: setup.impulseVolumeRatio,
                fibLevel: setup.pullbackDepth,
                impulseATR: setup.impulseATR
            }
        );
    }

    private calculateConfidence(candles: Candle[], setup: MomentumSetup): number {
        const last = candles[candles.length - 1];
        const prev = candles.length >= 2 ? candles[candles.length - 2] : last;

        const clamp01 = (v: number) => Math.max(0, Math.min(v, 1));

        // 1) Volume quality (1.0x..3.0x mapped to 0..1)
        const volumeScore = clamp01((setup.impulseVolumeRatio - 1.0) / 2.0);

        // 2) Recency: fresher impulse is better
        const recencyScore = clamp01(1 - (setup.barsSinceImpulse / 50));

        // 3) Pullback depth around ideal ~0.5 fib
        let fibScore = 0.5;
        if (setup.pullback) {
            const impulseRange = setup.impulseHigh - setup.impulseLow;
            if (Number.isFinite(impulseRange) && impulseRange > 0) {
                const isLong = setup.direction === TrendDirection.BULLISH;
                const pullbackDist = isLong
                    ? (setup.impulseHigh - setup.pullback.level)
                    : (setup.pullback.level - setup.impulseLow);
                const fib = pullbackDist / impulseRange;
                fibScore = clamp01(1 - (Math.abs(fib - 0.5) / 0.2));
            }
        }

        // 4) Pullback distance from EMA
        let pullbackDistanceScore = 0.5;
        if (setup.pullback && Number.isFinite(setup.pullback.distanceFromEMA)) {
            pullbackDistanceScore = clamp01(1 - (setup.pullback.distanceFromEMA / 1.5));
        }

        // 5) Bounce strength
        const isLong = setup.direction === TrendDirection.BULLISH;
        const bounceScore = clamp01(
            isLong
                ? (last.close > last.open ? 0.7 : 0.3) + (last.close > prev.close ? 0.3 : 0)
                : (last.close < last.open ? 0.7 : 0.3) + (last.close < prev.close ? 0.3 : 0)
        );

        // Weighted blend
        const score =
            volumeScore * 0.20 +
            recencyScore * 0.20 +
            fibScore * 0.25 +
            pullbackDistanceScore * 0.20 +
            bounceScore * 0.15;

        return clamp01(score);
    }

    private resetSetup(symbol: string): void {
        this.setups.set(symbol, {
            state: SetupState.IDLE,
            direction: TrendDirection.NEUTRAL,
            impulseHigh: 0,
            impulseLow: 0,
            impulseATR: 0,
            impulseVolumeRatio: 0,
            barsSinceImpulse: 0
        });
    }

    private invalidate(symbol: string, reason: string): null {
        const setup = this.setups.get(symbol);
        this.debug(symbol, `❌ INVALIDATED: ${reason}`, setup);
        if (setup) setup.state = SetupState.INVALIDATED;
        return null;
    }

    private debug(symbol: string, label: string, data?: any) {
        this.logger.debug(`STRATEGY | ${symbol} | ${label}`, data);
    }

    private info(symbol: string, label: string, data?: any) {
        this.logger.info(`STRATEGY | ${symbol} | ${label}`, data);
    }
}
