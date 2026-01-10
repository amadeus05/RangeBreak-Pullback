import { createContainer, TYPES } from '../../config/inversify.config';
import { RunLiveTrading } from '../../application/use-cases/RunLiveTrading';
import { Logger } from '../../shared/logger/Logger';

export async function runLiveCommand(args: {
    symbol: string;
    tickInterval?: number;
}): Promise<void> {
    const logger = Logger.getInstance();
    
    try {
        const container = createContainer('live');
        
        const strategy = container.get<RunLiveTrading>(RunLiveTrading);

        logger.info('Starting live trading...');
        logger.info(`Symbol: ${args.symbol}`);
        logger.info(`Tick Interval: ${args.tickInterval || 5000}ms`);

        await strategy.start({
            symbol: args.symbol,
            tickInterval: args.tickInterval || 5000
        });
    } catch (error) {
        logger.error('Live trading failed', error);
        throw error;
    }
}