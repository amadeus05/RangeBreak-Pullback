import { createContainer } from '../../config/inversify.config';
import { RunLiveTrading } from '../../application/use-cases/RunLiveTrading';
import { Logger } from '../../shared/logger/Logger';

export async function runLiveCommand(args: {
    symbols: string[]; // Change this to symbols array to match index.ts
    tickInterval?: number;
}): Promise<void> {
    const logger = Logger.getInstance();
    
    try {
        const container = createContainer('live');
        const liveTrading = container.get<RunLiveTrading>(RunLiveTrading);

        logger.info('Starting live trading...');
        // For now, let's take the first symbol since RunLiveTrading 
        // logic provided is designed for a single symbol loop
        const symbol = args.symbols[0]; 

        logger.info(`Symbol: ${symbol}`);
        logger.info(`Tick Interval: ${args.tickInterval || 5000}ms`);

        await liveTrading.start({
            symbol: symbol,
            tickInterval: args.tickInterval || 5000
        });
    } catch (error) {
        logger.error('Live trading failed', error);
        throw error;
    }
}