import 'reflect-metadata';
import { Container } from 'inversify';
import { IExchange } from '../domain/interfaces/IExchange';
import { IIndicatorEngine } from '../domain/interfaces/IIndicatorEngine';
import { IMarketRegimeFilter } from '../domain/interfaces/IMarketRegimeFilter';
import { IRangeDetector } from '../domain/interfaces/IRangeDetector';
import { IBreakoutDetector } from '../domain/interfaces/IBreakoutDetector';
import { IPullbackValidator } from '../domain/interfaces/IPullbackValidator';
import { IRiskEngine } from '../domain/interfaces/IRiskEngine';
import { IStateMachine } from '../domain/interfaces/IStateMachine';
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

export const TYPES = {
    IExchange: Symbol.for('IExchange'),
    IIndicatorEngine: Symbol.for('IIndicatorEngine'),
    IMarketRegimeFilter: Symbol.for('IMarketRegimeFilter'),
    IRangeDetector: Symbol.for('IRangeDetector'),
    IBreakoutDetector: Symbol.for('IBreakoutDetector'),
    IPullbackValidator: Symbol.for('IPullbackValidator'),
    IRiskEngine: Symbol.for('IRiskEngine'),
    IStateMachine: Symbol.for('IStateMachine'),
    Strategy: Symbol.for('Strategy')
};

export function createContainer(mode: 'backtest' | 'live'): Container {
    const container = new Container();

    // Exchange - зависит от режима
    if (mode === 'backtest') {
        container.bind<IExchange>(TYPES.IExchange).to(PaperTradingExchange).inSingletonScope();
    } else {
        container.bind<IExchange>(TYPES.IExchange).to(BybitExchangeAdapter).inSingletonScope();
    }

    // Services
    container.bind<IIndicatorEngine>(TYPES.IIndicatorEngine).to(IndicatorEngine).inSingletonScope();
    container.bind<IMarketRegimeFilter>(TYPES.IMarketRegimeFilter).to(MarketRegimeFilter);
    container.bind<IRangeDetector>(TYPES.IRangeDetector).to(RangeDetector);
    container.bind<IBreakoutDetector>(TYPES.IBreakoutDetector).to(BreakoutDetector);
    container.bind<IPullbackValidator>(TYPES.IPullbackValidator).to(PullbackValidator);
    container.bind<IRiskEngine>(TYPES.IRiskEngine).to(RiskEngine);
    container.bind<IStateMachine>(TYPES.IStateMachine).to(StateMachine).inSingletonScope();

    // Strategy
    container.bind<RangeBreakPullbackStrategy>(TYPES.Strategy).to(RangeBreakPullbackStrategy);

    return container;
}