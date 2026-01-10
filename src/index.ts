import 'reflect-metadata';
import { createContainer, TYPES } from './config/inversify.config';
import { RangeBreakPullbackStrategy } from './application/strategies/RangeBreakPullbackStrategy';
import { Logger } from './shared/logger/Logger';

async function main() {
    const logger = Logger.getInstance();
    logger.info('Starting Range Break + Pullback Strategy');

    // Create DI container for backtest mode
    const container = createContainer('backtest');
    
    // Get strategy instance
    const strategy = container.get<RangeBreakPullbackStrategy>(TYPES.Strategy);
    
    logger.info('Strategy initialized successfully');
    
    // TODO: Implement backtest runner or live trading loop
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});