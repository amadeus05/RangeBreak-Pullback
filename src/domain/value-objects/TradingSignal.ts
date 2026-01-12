import { TradeDirection } from '../enums/TradeDirection';

export type OrderType = 'MARKET' | 'LIMIT';

export interface TradingSignalMeta {
    reason: string;
    confidence?: number;
    rangeHigh?: number;
    rangeLow?: number;
    atr?: number;
}

export class TradingSignal {
    constructor(
        public readonly symbol: string,
        public readonly direction: TradeDirection,
        public readonly orderType: OrderType,
        public readonly price: number, // для LIMIT это лимит-цена, для MARKET — текущая
        public readonly stopLoss: number,
        public readonly takeProfit: number,
        public readonly timestamp: number,
        public readonly meta: TradingSignalMeta
    ) {}

    static createLimitOrder(
        symbol: string,
        direction: TradeDirection,
        limitPrice: number,
        stopLoss: number,
        takeProfit: number,
        timestamp: number,
        meta: TradingSignalMeta
    ): TradingSignal {
        return new TradingSignal(
            symbol,
            direction,
            'LIMIT',
            limitPrice,
            stopLoss,
            takeProfit,
            timestamp,
            meta
        );
    }

    static createMarketOrder(
        symbol: string,
        direction: TradeDirection,
        currentPrice: number,
        stopLoss: number,
        takeProfit: number,
        timestamp: number,
        meta: TradingSignalMeta
    ): TradingSignal {
        return new TradingSignal(
            symbol,
            direction,
            'MARKET',
            currentPrice,
            stopLoss,
            takeProfit,
            timestamp,
            meta
        );
    }

    get stopDistance(): number {
        return Math.abs(this.price - this.stopLoss);
    }

    get riskRewardRatio(): number {
        const reward = Math.abs(this.takeProfit - this.price);
        const risk = this.stopDistance;
        return risk > 0 ? reward / risk : 0;
    }
}