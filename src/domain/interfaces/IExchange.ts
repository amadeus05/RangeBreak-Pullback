import { Candle } from '../entities/Candle';
import { Position } from '../entities/Position';

export interface IExchange {
    getCandles(symbol: string, timeframe: string, limit?: number, startTime?: number): Promise<Candle[]>;
    getCurrentPrice(symbol: string): Promise<number>;
    placeOrder(symbol: string, side: 'Buy' | 'Sell', qty: number, price?: number): Promise<string>;
    cancelOrder(orderId: string): Promise<void>;
    getPosition(symbol: string): Promise<Position | null>;
    closePosition(symbol: string): Promise<void>;
}