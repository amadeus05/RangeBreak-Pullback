import { TradeDirection } from '../enums/TradeDirection';

export class Position {
    constructor(
        public readonly symbol: string,
        public readonly direction: TradeDirection,
        public readonly entryPrice: number,
        public readonly size: number,
        public readonly stopLoss: number,
        public readonly takeProfit: number,
        public readonly entryTime: number
    ) {}

    get risk(): number {
        return Math.abs(this.entryPrice - this.stopLoss) * this.size;
    }

    get reward(): number {
        return Math.abs(this.takeProfit - this.entryPrice) * this.size;
    }

    get riskRewardRatio(): number {
        return this.reward / this.risk;
    }
}