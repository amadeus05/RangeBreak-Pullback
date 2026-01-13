import 'reflect-metadata';
import { Container } from 'inversify';
import { TYPES } from './types';

// Interfaces
import { IExchange } from '../domain/interfaces/IExchange';
import { IIndicatorEngine } from '../domain/interfaces/IIndicatorEngine';
import { IMarketRegimeFilter } from '../domain/interfaces/IMarketRegimeFilter';
import { IRangeDetector } from '../domain/interfaces/IRangeDetector';
import { IBreakoutDetector } from '../domain/interfaces/IBreakoutDetector';
import { IPullbackValidator } from '../domain/interfaces/IPullbackValidator';
import { IRiskEngine } from '../domain/interfaces/IRiskEngine';
import { IStateMachine } from '../domain/interfaces/IStateMachine';

// Implementations
import { BybitExchangeAdapter } from '../infrastructure/exchanges/bybit/BybitExchangeAdapter';
import { PaperTradingExchange } from '../infrastructure/exchanges/paper-trading/PaperTradingExchange';
import { IndicatorEngine } from '../application/services/indicators/IndicatorEngine';
import { MarketRegimeFilter } from '../application/services/market/MarketRegimeFilter';
import { RangeDetector } from '../application/services/detection/RangeDetector';
import { BreakoutDetector } from '../application/services/detection/BreakoutDetector';
import { PullbackValidator } from '../application/services/validation/PullbackValidator';
import { RiskEngine } from '../application/services/risk/RiskEngine';
import { StateMachine } from '../application/services/state/StateMachine';
import { RangeBreakPullbackStrategy } from '../application/strategies/RangeBreakPullbackStrategy';
import { IIndicators } from '../domain/interfaces/IIndicators';
import { IndicatorsProvider } from '../application/services/indicators/IndicatorsProvider';
import { RegimeDetector } from '../application/services/market/RegimeDetector';
import { TrendAnalyzer } from '../application/services/detection/TrendAnalyzer';
import { PullbackScanner } from '../application/services/detection/PullbackScanner';
import { MomentumDetector } from '../application/services/detection/MomentumDetector';
import { TrendContinuationStrategy } from '../application/strategies/TrendContinuationStrategy';
import { MomentumStrategy } from '../application/strategies/MomentumStrategy';

// NEW: Portfolio & Execution
import { PortfolioManager } from '../application/services/portfolio/PortfolioManager';
import { ExecutionEngine } from '../application/services/execution/ExecutionEngine';

// Repositories & UseCases
import { CandleRepository } from '../infrastructure/database/repositories/CandleRepository';
import { TradeRepository } from '../infrastructure/database/repositories/TradeRepository';
import { RunBacktest } from '../application/use-cases/RunBacktest';
import { RunLiveTrading } from '../application/use-cases/RunLiveTrading';

export { TYPES };

export function createContainer(mode: 'backtest' | 'live', initialBalance: number = 500): Container {
    const container = new Container();

    // --- Core Services ---
    container.bind<IIndicatorEngine>(TYPES.IIndicatorEngine).to(IndicatorEngine).inSingletonScope();
    container.bind<IMarketRegimeFilter>(TYPES.IMarketRegimeFilter).to(MarketRegimeFilter);
    container.bind<IRangeDetector>(TYPES.IRangeDetector).to(RangeDetector);
    container.bind<IBreakoutDetector>(TYPES.IBreakoutDetector).to(BreakoutDetector);
    container.bind<IPullbackValidator>(TYPES.IPullbackValidator).to(PullbackValidator);
    container.bind<IRiskEngine>(TYPES.IRiskEngine).to(RiskEngine);
    container.bind<IStateMachine>(TYPES.IStateMachine).to(StateMachine).inSingletonScope();

    // New Components
    container.bind<IIndicators>(TYPES.IIndicators).to(IndicatorsProvider).inSingletonScope();
    container.bind<RegimeDetector>(TYPES.RegimeDetector).to(RegimeDetector).inSingletonScope();
    container.bind<TrendAnalyzer>(TYPES.TrendAnalyzer).to(TrendAnalyzer).inSingletonScope();
    container.bind<PullbackScanner>(TYPES.PullbackScanner).to(PullbackScanner).inSingletonScope();
    container.bind<MomentumDetector>(TYPES.MomentumDetector).to(MomentumDetector).inSingletonScope();

    // Strategy
    container.bind<TrendContinuationStrategy>(TYPES.Strategy).to(TrendContinuationStrategy);
    container.bind<MomentumStrategy>(TYPES.MomentumStrategy).to(MomentumStrategy).inSingletonScope();

    // --- NEW: Portfolio Manager (с начальным балансом) ---
    container.bind<PortfolioManager>(PortfolioManager).toConstantValue(
        new PortfolioManager(initialBalance)
    );

    // --- NEW: Execution Engine ---
    container.bind<ExecutionEngine>(ExecutionEngine).toSelf().inSingletonScope();

    // --- Repositories ---
    container.bind<CandleRepository>(CandleRepository).toSelf().inSingletonScope();
    container.bind<TradeRepository>(TradeRepository).toSelf().inSingletonScope();

    // --- Exchanges Setup ---
    // DataFeed: Всегда Bybit
    container.bind<IExchange>(TYPES.IDataFeed).to(BybitExchangeAdapter).inSingletonScope();

    // Execution Exchange: Зависит от режима
    if (mode === 'backtest') {
        container.bind<IExchange>(TYPES.IExchange).to(PaperTradingExchange).inSingletonScope();
        container.bind<RunBacktest>(RunBacktest).toSelf();
    } else {
        container.bind<IExchange>(TYPES.IExchange).to(BybitExchangeAdapter).inSingletonScope();
        container.bind<RunLiveTrading>(RunLiveTrading).toSelf();
    }

    return container;
}