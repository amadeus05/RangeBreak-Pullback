export class Candle {
    constructor(
        public readonly timestamp: number,
        public readonly open: number,
        public readonly high: number,
        public readonly low: number,
        public readonly close: number,
        public readonly volume: number,
        public readonly symbol: string,
        public readonly timeframe: string
    ) {}

    get body(): number {
        return Math.abs(this.close - this.open);
    }

    get bodyPercent(): number {
        const range = this.high - this.low;
        return range > 0 ? (this.body / range) * 100 : 0;
    }

    get isBullish(): boolean {
        return this.close > this.open;
    }

    get isBearish(): boolean {
        return this.close < this.open;
    }

    get upperWick(): number {
        return this.high - Math.max(this.open, this.close);
    }

    get lowerWick(): number {
        return Math.min(this.open, this.close) - this.low;
    }
}