// src/application/services/portfolio/PortfolioManager.ts

import { injectable } from 'inversify';

interface TradeResult {
    pnl: number;
    fees: number;
    netPnl: number;
}

interface EquitySnapshot {
    timestamp: number;
    equity: number;
}

@injectable()
export class PortfolioManager {
    private balance: number;
    private dailyLoss: number = 0;
    private consecutiveLosses: number = 0;
    private lastDayProcessed: number = -1;

    // ❌ FIX #7: Equity curve & drawdown tracking
    private equityCurve: EquitySnapshot[] = [];
    private peakEquity: number;
    private maxDrawdown: number = 0;

    private readonly MAX_DAILY_LOSS_PERCENT = 0.10; // 10%
    private readonly MAX_CONSECUTIVE_LOSSES = 10;

    constructor(initialBalance: number) {
        this.balance = initialBalance;
        this.peakEquity = initialBalance;
    }

    getBalance(): number {
        return this.balance;
    }

    getDailyLoss(): number {
        return this.dailyLoss;
    }

    getConsecutiveLosses(): number {
        return this.consecutiveLosses;
    }

    // Проверка kill-switch
    canTrade(): boolean {
        if (this.dailyLoss / this.balance >= this.MAX_DAILY_LOSS_PERCENT) {
            return false;
        }
        if (this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
            return false;
        }
        return true;
    }

    // Сброс дневной статистики
    resetDailyStats(currentTimestamp: number): void {
        const currentDay = new Date(currentTimestamp).getUTCDate();
        if (currentDay !== this.lastDayProcessed) {
            if (this.lastDayProcessed !== -1) {
                this.dailyLoss = 0;
                this.consecutiveLosses = 0;
            }
            this.lastDayProcessed = currentDay;
        }
    }

    // ❌ FIX #5: Deduct fee (entry or exit)
    deductFee(fee: number): void {
        this.balance -= fee;
    }

    // Обновление после закрытия сделки
    applyTradeResult(result: TradeResult): void {
        const { pnl } = result;
        // Note: netPnl = pnl - fees, but fees are already deducted via deductFee()
        // So we only add raw pnl here
        this.balance += pnl;

        if (result.netPnl < 0) {
            this.dailyLoss += Math.abs(result.netPnl);
            this.consecutiveLosses++;
        } else {
            this.consecutiveLosses = 0;
        }
    }

    // ❌ FIX #7: Record equity snapshot and calculate drawdown
    recordEquity(timestamp: number): void {
        this.equityCurve.push({ timestamp, equity: this.balance });

        // Update peak equity
        if (this.balance > this.peakEquity) {
            this.peakEquity = this.balance;
        }

        // Calculate current drawdown
        const currentDrawdown = (this.peakEquity - this.balance) / this.peakEquity;
        if (currentDrawdown > this.maxDrawdown) {
            this.maxDrawdown = currentDrawdown;
        }
    }

    getMaxDrawdown(): number {
        return this.maxDrawdown;
    }

    getEquityCurve(): EquitySnapshot[] {
        return this.equityCurve;
    }

    getPeakEquity(): number {
        return this.peakEquity;
    }

    // Для тестов / сброса
    setBalance(newBalance: number): void {
        this.balance = newBalance;
    }
}