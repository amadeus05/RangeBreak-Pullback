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
import { TYPES } from '../../config/inversify.config';
import { Logger } from '../../shared/logger/Logger';

// ИНКАПСУЛЯЦИЯ ДАННЫХ (Problem: Strategy Context)
interface StrategyContext {
    range: MarketRange | null;
    breakout: BreakoutSignal | null;
    lastProcessedBar5m: number;
    indicators: {
        atr: number;
        adx: number;
        volumeSMA: number;
    };
}

@injectable()
export class RangeBreakPullbackStrategy {
    private logger = Logger.getInstance();
    
    // Единый источник истины для данных сетапа
    private ctx: StrategyContext = this.getDefaultContext();

    private dailyLoss: number = 0;
    private consecutiveLosses: number = 0;
    
    constructor(
        @inject(TYPES.IExchange) private readonly exchange: IExchange,
        @inject(TYPES.IIndicatorEngine) private readonly indicatorEngine: IIndicatorEngine,
        @inject(TYPES.IMarketRegimeFilter) private readonly marketFilter: IMarketRegimeFilter,
        @inject(TYPES.IRangeDetector) private readonly rangeDetector: IRangeDetector,
        @inject(TYPES.IBreakoutDetector) private readonly breakoutDetector: IBreakoutDetector,
        @inject(TYPES.IPullbackValidator) private readonly pullbackValidator: IPullbackValidator,
        @inject(TYPES.IRiskEngine) private readonly riskEngine: IRiskEngine,
        @inject(TYPES.IStateMachine) private readonly stateMachine: IStateMachine
    ) {}

    private getDefaultContext(): StrategyContext {
        return {
            range: null,
            breakout: null,
            lastProcessedBar5m: 0,
            indicators: { atr: 0, adx: 0, volumeSMA: 0 }
        };
    }

    async processTick(symbol: string, candles5m: Candle[], candles1m: Candle[]): Promise<void> {
        // --- 1. KILL SWITCH (Highest Priority - Problem #3) ---
        const balance = 10000; // TODO: Get from exchange
        if (!this.riskEngine.canTrade(balance, this.dailyLoss, this.consecutiveLosses)) {
            if (this.stateMachine.getCurrentState() !== StrategyState.IDLE) {
                this.forceReset('CRITICAL: Kill Switch triggered');
            }
            return;
        }

        const currentState = this.stateMachine.getCurrentState();
        const last5m = candles5m[candles5m.length - 1];

        // --- 2. TIMEOUTS & MONITORING ---
        this.checkTimeouts();

        // --- 3. 5m BRAIN (Structure & State Transitions) ---
        if (last5m.timestamp > this.ctx.lastProcessedBar5m) {
            await this.handleHighTimeframeLogic(candles5m);
            this.ctx.lastProcessedBar5m = last5m.timestamp;
        }

        // --- 4. 1m HANDS (Execution Confirmation) ---
        await this.handleLowTimeframeLogic(candles1m);
    }

    private async handleHighTimeframeLogic(candles5m: Candle[]): Promise<void> {
        const state = this.stateMachine.getCurrentState();

        // ONE SETUP AT A TIME (Problem: Explicit blockade)
        if (state !== StrategyState.IDLE && state !== StrategyState.RANGE_DEFINED) return;

        if (state === StrategyState.IDLE) {
            if (!this.marketFilter.isMarketValid(candles5m)) return;

            const range = this.rangeDetector.detectRange(candles5m);
            const atr = this.indicatorEngine.calculateATR(candles5m, 14);
            
            if (range && this.rangeDetector.isRangeValid(range, atr)) {
                this.ctx.range = range;
                this.ctx.indicators.atr = atr;
                this.logStateSnapshot(StrategyState.RANGE_DEFINED, 'New Range Found');
                this.stateMachine.transition(StrategyState.RANGE_DEFINED, 'Range Frozen');
            }
            return;
        }

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
                this.ctx.breakout = breakout;
                this.ctx.indicators.volumeSMA = volumeSMA;
                this.logStateSnapshot(StrategyState.BREAKOUT_DETECTED, 'Breakout Confirmed');
                this.stateMachine.transition(StrategyState.BREAKOUT_DETECTED, '5m Breakout Confirmed');
                this.stateMachine.transition(StrategyState.WAIT_PULLBACK, 'Handing over to 1m');
            }
        }
    }

    private async handleLowTimeframeLogic(candles1m: Candle[]): Promise<void> {
        if (this.stateMachine.getCurrentState() !== StrategyState.WAIT_PULLBACK) return;

        const vwap = this.indicatorEngine.calculateVWAP(candles1m);
        const last1m = candles1m[candles1m.length - 1];

        const pullbackValid = this.pullbackValidator.isPullbackValid(
            candles1m,
            this.ctx.breakout!,
            this.ctx.range!,
            vwap
        );

        if (pullbackValid && this.pullbackValidator.hasPullbackPattern(last1m, this.ctx.breakout!.direction)) {
            this.logStateSnapshot(StrategyState.ENTRY_PLACED, 'Pullback Entry Triggered');
            this.stateMachine.transition(StrategyState.ENTRY_PLACED, 'Pattern confirmed on 1m');
            // TODO: call ExecutionEngine.placeOrder()
        }
    }

    private checkTimeouts(): void {
        const state = this.stateMachine.getCurrentState();
        if (state === StrategyState.IDLE) return;

        const timeInState = this.stateMachine.getTimeInState();

        if (state === StrategyState.WAIT_PULLBACK && timeInState > 15 * 60 * 1000) {
            this.forceReset('Pullback timeout');
        }
    }

    // SNAPSHOT LOGGING (Problem #4)
    private logStateSnapshot(newState: StrategyState, reason: string): void {
        this.logger.info(`[STRATEGY SNAPSHOT] Transition to ${newState}`, {
            reason,
            range: this.ctx.range ? { h: this.ctx.range.high, l: this.ctx.range.low } : 'null',
            breakout: this.ctx.breakout ? { dir: this.ctx.breakout.direction, price: this.ctx.breakout.price } : 'null',
            atr: this.ctx.indicators.atr,
            volSMA: this.ctx.indicators.volumeSMA,
            timeInPrevState: this.stateMachine.getTimeInState()
        });
    }

    private forceReset(reason: string): void {
        this.ctx = this.getDefaultContext(); // Полная очистка контекста (Problem #5)
        this.stateMachine.reset();
        this.logger.warn(`Strategy Reset: ${reason}`);
    }
}