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

// Repositories & UseCases (Обязательно импортируем!)
import { CandleRepository } from '../infrastructure/database/repositories/CandleRepository';
import { TradeRepository } from '../infrastructure/database/repositories/TradeRepository';
import { RunBacktest } from '../application/use-cases/RunBacktest';
import { RunLiveTrading } from '../application/use-cases/RunLiveTrading';

export { TYPES };

export function createContainer(mode: 'backtest' | 'live'): Container {
    const container = new Container();

    // --- Core Services ---
    container.bind<IIndicatorEngine>(TYPES.IIndicatorEngine).to(IndicatorEngine).inSingletonScope();
    container.bind<IMarketRegimeFilter>(TYPES.IMarketRegimeFilter).to(MarketRegimeFilter);
    container.bind<IRangeDetector>(TYPES.IRangeDetector).to(RangeDetector);
    container.bind<IBreakoutDetector>(TYPES.IBreakoutDetector).to(BreakoutDetector);
    container.bind<IPullbackValidator>(TYPES.IPullbackValidator).to(PullbackValidator);
    container.bind<IRiskEngine>(TYPES.IRiskEngine).to(RiskEngine);
    container.bind<IStateMachine>(TYPES.IStateMachine).to(StateMachine).inSingletonScope();
    container.bind<RangeBreakPullbackStrategy>(TYPES.Strategy).to(RangeBreakPullbackStrategy);

    // --- Repositories ---
    // Регистрируем репозитории, чтобы UseCase мог их получить
    container.bind<CandleRepository>(CandleRepository).toSelf().inSingletonScope();
    container.bind<TradeRepository>(TradeRepository).toSelf().inSingletonScope();

    // --- Exchanges Setup ---
    // 1. DataFeed: Всегда Bybit (для данных)
    container.bind<IExchange>(TYPES.IDataFeed).to(BybitExchangeAdapter).inSingletonScope();

    // 2. Execution Exchange: Зависит от режима
    if (mode === 'backtest') {
        container.bind<IExchange>(TYPES.IExchange).to(PaperTradingExchange).inSingletonScope();
        container.bind<RunBacktest>(RunBacktest).toSelf(); 
    } else {
        container.bind<IExchange>(TYPES.IExchange).to(BybitExchangeAdapter).inSingletonScope();
        
        // Для Live режима регистрируем RunLiveTrading
        container.bind<RunLiveTrading>(RunLiveTrading).toSelf();
    }

    return container;
}