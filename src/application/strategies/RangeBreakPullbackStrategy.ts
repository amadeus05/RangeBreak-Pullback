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

@injectable()
export class RangeBreakPullbackStrategy {
    private currentRange: MarketRange | null = null;
    private currentBreakout: BreakoutSignal | null = null;
    private pullbackStartTime: number | null = null;
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

    async processTick(symbol: string, candles5m: Candle[], candles1m: Candle[]): Promise<void> {
        const currentState = this.stateMachine.getCurrentState();

        // Global kill switch check
        const balance = 10000; // TODO: get from exchange
        if (!this.riskEngine.canTrade(balance, this.dailyLoss, this.consecutiveLosses)) {
            this.stateMachine.transition(StrategyState.RESET, 'Kill switch activated');
            return;
        }
        
        switch (currentState) {
            case StrategyState.IDLE:
                await this.handleIdleState(candles5m);
                break;
            
            case StrategyState.RANGE_DEFINED:
                await this.handleRangeDefinedState(candles5m);
                break;
            
            case StrategyState.BREAKOUT_DETECTED:
                await this.handleBreakoutDetectedState();
                break;
            
            case StrategyState.WAIT_PULLBACK:
                await this.handleWaitPullbackState(candles1m, candles5m);
                break;
            
            case StrategyState.ENTRY_PLACED:
                // Wait for order fill - handled by execution engine
                break;
            
            case StrategyState.IN_POSITION:
                // Monitor position - handled by position manager
                break;
            
            case StrategyState.RESET:
                this.handleResetState();
                break;
        }
    }

    private async handleIdleState(candles5m: Candle[]): Promise<void> {
        const marketValid = this.marketFilter.isMarketValid(candles5m);
        
        if (marketValid) {
            const range = this.rangeDetector.detectRange(candles5m);
            const atr = this.indicatorEngine.calculateATR(candles5m, 14);
            
            if (range && this.rangeDetector.isRangeValid(range, atr)) {
                this.currentRange = range;
                this.stateMachine.transition(StrategyState.RANGE_DEFINED, 'Valid range detected');
            }
        }
    }

    private async handleRangeDefinedState(candles5m: Candle[]): Promise<void> {
        if (!this.currentRange) {
            this.stateMachine.transition(StrategyState.RESET, 'No range defined');
            return;
        }

        const lastCandle = candles5m[candles5m.length - 1];
        const atr = this.indicatorEngine.calculateATR(candles5m, 14);
        const volumes = candles5m.map(c => c.volume);
        const volumeSMA = this.indicatorEngine.calculateSMA(volumes, 20);

        const breakout = this.breakoutDetector.detectBreakout(lastCandle, this.currentRange, atr, volumeSMA);
        
        if (breakout) {
            this.currentBreakout = breakout;
            this.stateMachine.transition(StrategyState.BREAKOUT_DETECTED, `Breakout detected: ${breakout.direction}`);
        }
    }

    private async handleBreakoutDetectedState(): Promise<void> {
        this.pullbackStartTime = Date.now();
        this.stateMachine.transition(StrategyState.WAIT_PULLBACK, 'Waiting for pullback');
    }

    private async handleWaitPullbackState(candles1m: Candle[], candles5m: Candle[]): Promise<void> {
        if (!this.currentBreakout || !this.currentRange) {
            this.stateMachine.transition(StrategyState.RESET, 'Missing breakout or range data');
            return;
        }

        // Timeout check: 10 candles * 1m = 10 minutes
        const elapsed = Date.now() - (this.pullbackStartTime || 0);
        if (elapsed > 10 * 60 * 1000) {
            this.stateMachine.transition(StrategyState.RESET, 'Pullback timeout');
            return;
        }

        const vwap = this.indicatorEngine.calculateVWAP(candles1m);
        const lastCandle = candles1m[candles1m.length - 1];

        const pullbackValid = this.pullbackValidator.isPullbackValid(
            candles1m,
            this.currentBreakout,
            this.currentRange,
            vwap
        );

        const hasPattern = this.pullbackValidator.hasPullbackPattern(
            lastCandle,
            this.currentBreakout.direction
        );

        if (pullbackValid && hasPattern) {
            this.stateMachine.transition(StrategyState.ENTRY_PLACED, 'Valid pullback with pattern');
            // TODO: Place LIMIT order via exchange
        }
    }

    private handleResetState(): void {
        this.currentRange = null;
        this.currentBreakout = null;
        this.pullbackStartTime = null;
        this.stateMachine.transition(StrategyState.IDLE, 'Reset complete');
    }
}