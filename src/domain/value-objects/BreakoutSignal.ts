import { TradeDirection } from '../enums/TradeDirection';

export class BreakoutSignal {
    constructor(
        public readonly direction: TradeDirection,
        public readonly impulseSize: number,
        public readonly impulseHigh: number,
        public readonly impulseLow: number,
        public readonly timestamp: number,
        public readonly price: number
    ) {}
}