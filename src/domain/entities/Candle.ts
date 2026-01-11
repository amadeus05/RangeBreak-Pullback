export class Candle {
    
    // Calculated properties for analysis
    public readonly buyVolume: number;
    public readonly sellVolume: number;
    public readonly delta: number;

    constructor(
        public readonly timestamp: number,
        public readonly open: number,
        public readonly high: number,
        public readonly low: number,
        public readonly close: number,
        public readonly volume: number,
        public readonly symbol: string,
        public readonly timeframe: string,
        takerBuyVolume?: number
    ) {
        // If takerBuyVolume is provided (Binance/Bybit), we calculate Delta
        // If not, we assume neutral (0) for safety
        if (takerBuyVolume !== undefined) {
            this.buyVolume = takerBuyVolume;
            this.sellVolume = volume - takerBuyVolume;
        } else {
            this.buyVolume = volume / 2;
            this.sellVolume = volume / 2;
        }
        
        this.delta = this.buyVolume - this.sellVolume;
    }

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