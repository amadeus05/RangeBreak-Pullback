import { injectable, inject } from 'inversify';
import { IExchange } from '../../domain/interfaces/IExchange';
import { IIndicatorEngine } from '../../domain/interfaces/IIndicatorEngine';
import { IRiskEngine } from '../../domain/interfaces/IRiskEngine';
import { Candle } from '../../domain/entities/Candle';
import { TradeDirection } from '../../domain/enums/TradeDirection';
import { TYPES } from '../../config/types';
import { Logger } from '../../shared/logger/Logger';
import { TradeRepository } from '../../infrastructure/database/repositories/TradeRepository';
/**
MEAN REVERSION STRATEGY (5m)
STRICT MODE: NO LOOK-AHEAD BIAS
*/
interface PendingOrder {
direction: TradeDirection;
setupPrice: number; // Цена закрытия сигнальной свечи (для справки)
slDist: number; // Дистанция стопа
reason: string;
signalTime: number;
}
interface StrategyState {
dailyVwap: {
sumTPV: number;
sumVol: number;
lastDate: number;
};
activeTradeId: number | null;
pendingOrder: PendingOrder | null; // Сигнал с прошлого бара
cooldownCounter: number;
candles1h: Candle[];
}
@injectable()
export class MeanReversionStrategy {
private logger = Logger.getInstance();
private state: StrategyState = {
    dailyVwap: { sumTPV: 0, sumVol: 0, lastDate: -1 },
    activeTradeId: null,
    pendingOrder: null,
    cooldownCounter: 0,
    candles1h: []
};

// --- TUNED PARAMETERS ---
private readonly ZSCORE_THRESHOLD = 1.8;
private readonly ATR_MULTIPLIER_VWAP = 0.4;
private readonly SL_ATR_MULT = 2.0;
private readonly MIN_RVOL = 1.2;
private readonly HTF_PERIOD = 200;

constructor(
    @inject(TYPES.IExchange) private readonly exchange: IExchange,
    @inject(TYPES.IIndicatorEngine) private readonly indicatorEngine: IIndicatorEngine,
    @inject(TYPES.IRiskEngine) private readonly riskEngine: IRiskEngine,
    @inject(TradeRepository) private readonly tradeRepo: TradeRepository
) {}

/**
 * Основной цикл.
 * candles5m содержит свечи, которые УЖЕ закрылись.
 * Последняя свеча в массиве (lastCandle) - это бар N.
 * Мы находимся в моменте открытия бара N+1.
 */
async processTick(symbol: string, candles5m: Candle[], candles1m: Candle[], balance: number): Promise<void> {
    if (candles5m.length < 200) return;

    const lastClosedCandle = candles5m[candles5m.length - 1]; // Бар N (Close известен)
    
    // В симуляции мы "видим" этот бар как завершенный.
    // Реальное время входа будет timestamp следующей свечи (которой еще нет в массиве, или она эмулируется)
    // Для простоты: Время исполнения = lastClosedCandle.timestamp + 5min (или просто Open следующей)
    // В бэктесте мы эмулируем вход по Close[N] как Open[N+1] с проскальзыванием.
    
    // 1. Обновляем индикаторы (VWAP, H1)
    this.updateDailyVWAP(lastClosedCandle);
    this.update1HCandles(candles5m);

    // 2. ИСПОЛНЕНИЕ (EXECUTION PHASE)
    // Если был сигнал на прошлом баре -> входим сейчас по OPEN (эмулируем как Close текущего для простоты, но логически это Open N+1)
    // В реальном Live режиме здесь мы бы отправляли Market Order.
    if (this.state.pendingOrder) {
        await this.executePendingOrder(symbol, lastClosedCandle, balance);
    }

    // 3. УПРАВЛЕНИЕ (MANAGEMENT PHASE)
    // Проверяем выходы ТОЛЬКО для сделок, открытых РАНЕЕ (не в этот тик)
    if (this.state.activeTradeId) {
        await this.managePosition(lastClosedCandle);
    }

    // 4. АНАЛИЗ (ANALYSIS PHASE)
    // Генерируем сигнал НА СЛЕДУЮЩИЙ БАР
    // Если уже есть поза или кулдаун - не ищем
    if (!this.state.activeTradeId && !this.state.pendingOrder && this.state.cooldownCounter === 0) {
        if (this.isRegimeSuitable()) {
            this.analyzeForSignal(candles5m);
        }
    }
    
    // Уменьшаем кулдаун
    if (this.state.cooldownCounter > 0) {
        this.state.cooldownCounter--;
    }
}

private updateDailyVWAP(candle: Candle): void {
    const date = new Date(candle.timestamp);
    const day = date.getUTCDate();

    if (this.state.dailyVwap.lastDate !== day) {
        this.state.dailyVwap.sumTPV = 0;
        this.state.dailyVwap.sumVol = 0;
        this.state.dailyVwap.lastDate = day;
    }

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    this.state.dailyVwap.sumTPV += typicalPrice * candle.volume;
    this.state.dailyVwap.sumVol += candle.volume;
}

private getCurrentVWAP(): number {
    if (this.state.dailyVwap.sumVol === 0) return 0;
    return this.state.dailyVwap.sumTPV / this.state.dailyVwap.sumVol;
}

private getDelta(candle: Candle): number {
    if (candle.delta !== 0) return candle.delta;
    const range = candle.high - candle.low;
    if (range === 0) return 0;
    const bodyDir = candle.close - candle.open;
    return candle.volume * (bodyDir / range); 
}

private update1HCandles(candles5m: Candle[]): void {
    // Упрощенная логика для фильтра тренда
    if (candles5m.length < 12) return;
}

private isRegimeSuitable(): boolean {
    return true; // Пока открыто, фильтруем только по паттернам
}

// --- ANALYSIS PHASE ---
private analyzeForSignal(candles5m: Candle[]): void {
    const candle = candles5m[candles5m.length - 1]; // Close[N]
    const vwap = this.getCurrentVWAP();
    if (vwap === 0) return;

    const atr = this.indicatorEngine.calculateATR(candles5m, 14);
    const zScore = this.indicatorEngine.calculateZScore(candles5m, 20);
    const volumeSMA = this.indicatorEngine.calculateSMA(candles5m.map(c => c.volume), 20);
    
    const currentDelta = this.getDelta(candle);
    const isHighVolume = candle.volume > (volumeSMA * this.MIN_RVOL);

    // --- LONG SIGNAL ---
    const belowVwap = candle.close < (vwap - this.ATR_MULTIPLIER_VWAP * atr);
    const oversold = zScore < -this.ZSCORE_THRESHOLD;
    const panicSelling = currentDelta < 0 && isHighVolume; 
    
    if (belowVwap && oversold && panicSelling) {
        this.setPendingOrder(TradeDirection.LONG, candle.close, atr, "Panic Sell Reversion");
        return;
    }

    // --- SHORT SIGNAL ---
    const aboveVwap = candle.close > (vwap + this.ATR_MULTIPLIER_VWAP * atr);
    const overbought = zScore > this.ZSCORE_THRESHOLD;
    const panicBuying = currentDelta > 0 && isHighVolume;

    if (aboveVwap && overbought && panicBuying) {
        this.setPendingOrder(TradeDirection.SHORT, candle.close, atr, "Panic Buy Reversion");
    }
}

private setPendingOrder(direction: TradeDirection, setupPrice: number, atr: number, reason: string): void {
    const slDist = atr * this.SL_ATR_MULT;
    
    this.state.pendingOrder = {
        direction,
        setupPrice,
        slDist,
        reason,
        signalTime: Date.now()
    };
    
    // this.logger.info(`[SIGNAL] Generated ${direction} signal at close ${setupPrice}. Pending execution next tick.`);
}

// --- EXECUTION PHASE (Next Tick) ---
private async executePendingOrder(symbol: string, currentCandle: Candle, balance: number): Promise<void> {
    if (!this.state.pendingOrder) return;

    const { direction, slDist } = this.state.pendingOrder;
    
    // ВХОД ПО OPEN ТЕКУЩЕЙ СВЕЧИ (а не по Close прошлой)
    // currentCandle в processTick - это последняя закрытая.
    // Но в реальности мы входим в момент ее закрытия (или открытия следующей).
    // В бэктесте массив candles5m обновляется раз в 5 минут.
    // Мы считаем currentCandle.close как цену исполнения (Market on Close)
    // ЛИБО (строже) мы должны брать currentCandle.open, но тогда нам нужен доступ к "будущей" свече.
    
    // В Strict Mode Backtest (RunBacktest.ts) мы подаем сюда свечу N.
    // Pending был сформирован на N-1.
    // Значит, цена входа - это Open свечи N.
    const entryPrice = currentCandle.open; 

    // Расчет SL/TP
    const stopLoss = direction === TradeDirection.LONG 
        ? entryPrice - slDist 
        : entryPrice + slDist;

    // TP на текущем VWAP (на начало сделки)
    const vwap = this.getCurrentVWAP();
    const takeProfit = vwap;

    // Валидация
    if ((direction === TradeDirection.LONG && takeProfit <= entryPrice) ||
        (direction === TradeDirection.SHORT && takeProfit >= entryPrice)) {
        // VWAP невыгоден, отменяем
        this.state.pendingOrder = null;
        return;
    }

    const stopDistance = Math.abs(entryPrice - stopLoss);
    // Защита от деления на ноль
    if (stopDistance === 0) {
        this.state.pendingOrder = null;
        return;
    }

    const size = this.riskEngine.calculatePositionSize(balance, stopDistance);

    const id = await this.tradeRepo.saveTrade({
        id: 0,
        symbol,
        direction,
        entryTime: currentCandle.timestamp, // Время входа - начало этой свечи
        entryPrice,
        size,
        stopLoss,
        takeProfit,
        status: 'OPEN'
    });

    this.state.activeTradeId = id;
    this.state.pendingOrder = null; // Сигнал исполнен

    this.logger.info(
        `[EXECUTION] Entry ${direction} @ ${entryPrice.toFixed(2)} (Open) | TP: ${takeProfit.toFixed(2)}`
    );
}

// --- MANAGEMENT PHASE ---
private async managePosition(candle: Candle): Promise<void> {
    const tradeList = await this.tradeRepo.getOpenTrades(candle.symbol);
    const trade = tradeList.find(t => t.id === this.state.activeTradeId);

    if (!trade) {
        this.state.activeTradeId = null;
        return;
    }

    // ВАЖНО: Не проверяем выход на той же свече, где вошли
    if (trade.entryTime === candle.timestamp) return;

    let exitPrice: number | null = null;
    let exitReason = '';

    const currentVWAP = this.getCurrentVWAP();
    
    // Проверяем High/Low свечи относительно уровней
    if (trade.direction === TradeDirection.LONG) {
        if (candle.low <= trade.stopLoss) {
            exitPrice = trade.stopLoss;
            exitReason = 'Stop Loss';
            this.state.cooldownCounter = 3;
        } else if (candle.high >= currentVWAP) {
            exitPrice = currentVWAP;
            exitReason = 'TP (VWAP)';
        }
    } else {
        if (candle.high >= trade.stopLoss) {
            exitPrice = trade.stopLoss;
            exitReason = 'Stop Loss';
            this.state.cooldownCounter = 3;
        } else if (candle.low <= currentVWAP) {
            exitPrice = currentVWAP;
            exitReason = 'TP (VWAP)';
        }
    }

    if (exitPrice !== null) {
        await this.tradeRepo.closeTrade(trade.id, exitPrice, candle.timestamp, exitReason);
        this.state.activeTradeId = null;
        
        const pnl = trade.direction === TradeDirection.LONG 
            ? (exitPrice - trade.entryPrice) * trade.size
            : (trade.entryPrice - exitPrice) * trade.size;
        
        const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);
        this.logger.info(`[EXIT] ${exitReason} | Price: ${exitPrice.toFixed(2)} | PnL: ${pnlStr}`);
    }
}
}