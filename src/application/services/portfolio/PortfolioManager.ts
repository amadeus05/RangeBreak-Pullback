// src/application/services/portfolio/PortfolioManager.ts

import { injectable } from 'inversify';

interface TradeResult {
    pnl: number;
    fees: number;
    netPnl: number;
}

@injectable()
export class PortfolioManager {
    private balance: number;
    private dailyLoss: number = 0;
    private consecutiveLosses: number = 0;
    private lastDayProcessed: number = -1;

    private readonly MAX_DAILY_LOSS_PERCENT = 0.10; // 10%
    private readonly MAX_CONSECUTIVE_LOSSES = 10;

    constructor(initialBalance: number) {
        this.balance = initialBalance;
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

    // Обновление после закрытия сделки
    applyTradeResult(result: TradeResult): void {
        const { netPnl } = result;
        this.balance += netPnl;

        if (netPnl < 0) {
            this.dailyLoss += Math.abs(netPnl);
            this.consecutiveLosses++;
        } else {
            this.consecutiveLosses = 0;
        }
    }

    // Для тестов / сброса
    setBalance(newBalance: number): void {
        this.balance = newBalance;
    }
}