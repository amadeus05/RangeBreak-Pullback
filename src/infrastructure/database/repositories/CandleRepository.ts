import { PrismaClient, Candle as PrismaCandle } from '@prisma/client';
import { Candle } from '../../../domain/entities/Candle';
import { injectable } from 'inversify';

@injectable()
export class CandleRepository {
    private prisma: PrismaClient;

    constructor() {
        this.prisma = new PrismaClient();
    }

    async saveCandles(candles: Candle[]): Promise<void> {
        if (candles.length === 0) return;

        const symbol = candles[0].symbol;
        const timeframe = candles[0].timeframe;
        
        // 1. Быстро находим min и max timestamp пакета
        const timestamps = candles.map(c => c.timestamp);
        const minTime = Math.min(...timestamps);
        const maxTime = Math.max(...timestamps);

        // 2. Спрашиваем у базы: какие timestamp уже заняты в этом диапазоне?
        // (Ищем по timestamp, так как у вас там Unique Constraint)
        const existing = await this.prisma.candle.findMany({
            where: {
                timestamp: {
                    gte: BigInt(minTime),
                    lte: BigInt(maxTime)
                }
            },
            select: { timestamp: true }
        });

        // Превращаем в Set для мгновенного поиска. Set(17000001, 17000002...)
        const existingSet = new Set(existing.map(e => Number(e.timestamp)));

        // 3. Оставляем только те свечи, которых НЕТ в базе
        const candlesToInsert = candles.filter(c => !existingSet.has(c.timestamp));

        if (candlesToInsert.length === 0) return;

        // 4. Используем $transaction для пакетной вставки.
        // Это атомарно и намного быстрее, чем цикл await create.
        const operations = candlesToInsert.map(c => 
            this.prisma.candle.create({
                data: {
                    timestamp: BigInt(c.timestamp),
                    symbol: c.symbol,
                    timeframe: c.timeframe,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume
                }
            })
        );

        try {
            await this.prisma.$transaction(operations);
        } catch (error) {
            // Если вдруг в процессе транзакции все-таки вылетел дубликат (гонка потоков)
            // Фоллбек на старый надежный (медленный) метод только для этого пакета
            console.warn('Transaction failed (race condition?), falling back to sequential insert');
            for (const op of operations) {
                try { await op; } catch (e) {}
            }
        }
    }

    async getDataRange(symbol: string, timeframe: string): Promise<{ min: number, max: number } | null> {
        const aggr = await this.prisma.candle.aggregate({
            where: { symbol, timeframe },
            _min: { timestamp: true },
            _max: { timestamp: true }
        });

        if (!aggr._min.timestamp || !aggr._max.timestamp) {
            return null;
        }

        return {
            min: Number(aggr._min.timestamp),
            max: Number(aggr._max.timestamp)
        };
    }

    async getCandles(
        symbol: string,
        timeframe: string,
        startTime: number,
        endTime: number
    ): Promise<Candle[]> {
        const prismaCandles = await this.prisma.candle.findMany({
            where: {
                symbol,
                timeframe,
                timestamp: {
                    gte: BigInt(startTime),
                    lte: BigInt(endTime)
                }
            },
            orderBy: {
                timestamp: 'asc'
            }
        });

        return prismaCandles.map(this.toDomain);
    }

    async hasData(symbol: string, timeframe: string, timestamp: number): Promise<boolean> {
        const count = await this.prisma.candle.count({
            where: {
                symbol,
                timeframe,
                timestamp: BigInt(timestamp)
            }
        });

        return count > 0;
    }

    async getLastCandle(symbol: string, timeframe: string): Promise<Candle | null> {
        const prismaCandle = await this.prisma.candle.findFirst({
            where: {
                symbol,
                timeframe
            },
            orderBy: {
                timestamp: 'desc'
            }
        });

        return prismaCandle ? this.toDomain(prismaCandle) : null;
    }

    private toDomain(prismaCandle: PrismaCandle): Candle {
        return new Candle(
            Number(prismaCandle.timestamp),
            prismaCandle.open,
            prismaCandle.high,
            prismaCandle.low,
            prismaCandle.close,
            prismaCandle.volume,
            prismaCandle.symbol,
            prismaCandle.timeframe
        );
    }

    async disconnect(): Promise<void> {
        await this.prisma.$disconnect();
    }
}