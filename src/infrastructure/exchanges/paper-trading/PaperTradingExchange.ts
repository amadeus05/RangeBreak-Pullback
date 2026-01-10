import { injectable } from 'inversify';
import { IExchange } from '../../../domain/interfaces/IExchange';
import { Candle } from '../../../domain/entities/Candle';
import { Position } from '../../../domain/entities/Position';
import { TradeDirection } from '../../../domain/enums/TradeDirection';

@injectable()
export class PaperTradingExchange implements IExchange {
    private positions: Map<string, Position> = new Map();
    private orders: Map<string, any> = new Map();
    private balance: number = 300; // Starting balance
    private candleData: Map<string, Candle[]> = new Map();

    async getCandles(symbol: string, timeframe: string, limit?: number): Promise<Candle[]> {
        // В backteste данные подгружаются из БД или API
        const key = `${symbol}_${timeframe}`;
        return this.candleData.get(key) || [];
    }

    async getCurrentPrice(symbol: string): Promise<number> {
        const candles = await this.getCandles(symbol, '1m', 1);
        return candles[candles.length - 1]?.close || 0;
    }

    async placeOrder(
        symbol: string,
        side: 'Buy' | 'Sell',
        qty: number,
        price?: number
    ): Promise<string> {
        const orderId = `order_${Date.now()}_${Math.random()}`;
        
        this.orders.set(orderId, {
            symbol,
            side,
            qty,
            price,
            status: 'open',
            timestamp: Date.now()
        });

        return orderId;
    }

    async cancelOrder(orderId: string): Promise<void> {
        this.orders.delete(orderId);
    }

    async getPosition(symbol: string): Promise<Position | null> {
        return this.positions.get(symbol) || null;
    }

    async closePosition(symbol: string): Promise<void> {
        const position = this.positions.get(symbol);
        if (!position) return;

        const currentPrice = await this.getCurrentPrice(symbol);
        const pnl = position.direction === TradeDirection.LONG
            ? (currentPrice - position.entryPrice) * position.size
            : (position.entryPrice - currentPrice) * position.size;

        this.balance += pnl;
        this.positions.delete(symbol);
    }

    // Helper methods for backtest
    setCandles(symbol: string, timeframe: string, candles: Candle[]): void {
        const key = `${symbol}_${timeframe}`;
        this.candleData.set(key, candles);
    }

    getBalance(): number {
        return this.balance;
    }

    fillOrder(orderId: string, fillPrice: number): void {
        const order = this.orders.get(orderId);
        if (!order) return;

        const direction = order.side === 'Buy' ? TradeDirection.LONG : TradeDirection.SHORT;
        
        // Simplified: no SL/TP calculation here, done by strategy
        const position = new Position(
            order.symbol,
            direction,
            fillPrice,
            order.qty,
            0, // SL set by strategy
            0, // TP set by strategy
            Date.now()
        );

        this.positions.set(order.symbol, position);
        this.orders.delete(orderId);
    }
}