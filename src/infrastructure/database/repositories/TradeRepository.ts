import { PrismaClient, Trade as PrismaTrade } from '@prisma/client';
import { Position } from '../../../domain/entities/Position';
import { TradeDirection } from '../../../domain/enums/TradeDirection';
import { injectable } from 'inversify';

interface TradeRecord {
    id: number;
    symbol: string;
    direction: TradeDirection;
    entryTime: number;
    exitTime?: number;
    entryPrice: number;
    exitPrice?: number;
    size: number;
    stopLoss: number;
    takeProfit: number;
    pnl?: number;
    status: 'OPEN' | 'CLOSED' | 'CANCELLED';
    exitReason?: string;
}

@injectable()
export class TradeRepository {
    private prisma: PrismaClient;

    constructor() {
        this.prisma = new PrismaClient();
    }

    async saveTrade(trade: TradeRecord): Promise<number> {
        const created = await this.prisma.trade.create({
            data: {
                symbol: trade.symbol,
                direction: trade.direction,
                entryTime: BigInt(trade.entryTime),
                entryPrice: trade.entryPrice,
                size: trade.size,
                stopLoss: trade.stopLoss,
                takeProfit: trade.takeProfit,
                status: trade.status
            }
        });

        return created.id;
    }
    
    async clearTrades(): Promise<void> {
        await this.prisma.trade.deleteMany({});
    }

    async closeTrade(
        id: number,
        exitPrice: number,
        exitTime: number,
        exitReason: string
    ): Promise<void> {
        const trade = await this.prisma.trade.findUnique({ where: { id } });
        if (!trade) throw new Error(`Trade ${id} not found`);

        const pnl = trade.direction === 'LONG'
            ? (exitPrice - trade.entryPrice) * trade.size
            : (trade.entryPrice - exitPrice) * trade.size;

        const pnlPercent = (pnl / (trade.entryPrice * trade.size)) * 100;

        await this.prisma.trade.update({
            where: { id },
            data: {
                exitTime: BigInt(exitTime),
                exitPrice,
                pnl,
                pnlPercent,
                status: 'CLOSED',
                exitReason
            }
        });
    }

    async getOpenTrades(symbol: string): Promise<TradeRecord[]> {
        const trades = await this.prisma.trade.findMany({
            where: {
                symbol,
                status: 'OPEN'
            }
        });

        return trades.map(this.toDomain);
    }

    async getTradeHistory(symbol: string, limit: number = 100): Promise<TradeRecord[]> {
        const trades = await this.prisma.trade.findMany({
            where: { symbol },
            orderBy: { entryTime: 'desc' },
            take: limit
        });

        return trades.map(this.toDomain);
    }

    async getTradeStats(symbol: string): Promise<{
        total: number;
        wins: number;
        losses: number;
        winRate: number;
        totalPnl: number;
        profitFactor: number; // Добавили поле
    }> {
        const trades = await this.prisma.trade.findMany({
            where: {
                symbol,
                status: 'CLOSED'
            }
        });

        const total = trades.length;
        const wins = trades.filter(t => (t.pnl || 0) > 0).length;
        const losses = trades.filter(t => (t.pnl || 0) <= 0).length;
        const winRate = total > 0 ? (wins / total) * 100 : 0;
        const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

        // Считаем настоящий Profit Factor ($ Profit / $ Loss)
        const grossProfit = trades.reduce((sum, t) => sum + ((t.pnl || 0) > 0 ? (t.pnl || 0) : 0), 0);
        const grossLoss = trades.reduce((sum, t) => sum + ((t.pnl || 0) < 0 ? Math.abs(t.pnl || 0) : 0), 0);
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

        return { total, wins, losses, winRate, totalPnl, profitFactor };
    }

    private toDomain(prismaTrade: PrismaTrade): TradeRecord {
        return {
            id: prismaTrade.id,
            symbol: prismaTrade.symbol,
            direction: prismaTrade.direction as TradeDirection,
            entryTime: Number(prismaTrade.entryTime),
            exitTime: prismaTrade.exitTime ? Number(prismaTrade.exitTime) : undefined,
            entryPrice: prismaTrade.entryPrice,
            exitPrice: prismaTrade.exitPrice || undefined,
            size: prismaTrade.size,
            stopLoss: prismaTrade.stopLoss,
            takeProfit: prismaTrade.takeProfit,
            pnl: prismaTrade.pnl || undefined,
            status: prismaTrade.status as 'OPEN' | 'CLOSED' | 'CANCELLED',
            exitReason: prismaTrade.exitReason || undefined
        };
    }

    async disconnect(): Promise<void> {
        await this.prisma.$disconnect();
    }
}