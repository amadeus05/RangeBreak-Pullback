# Range Break + Pullback Trading Strategy

TypeScript implementation of Range Break + Pullback strategy with Clean Architecture, SOLID principles, and Dependency Injection.

## 📁 Project Structure

```
src/
├── domain/                          # Бизнес-логика, entities, interfaces
│   ├── entities/
│   │   ├── Candle.ts               # Свеча (open, high, low, close, volume)
│   │   ├── Position.ts             # Позиция (entry, exit, SL, TP)
│   │   └── index.ts
│   ├── value-objects/
│   │   ├── MarketRange.ts          # Диапазон рынка (high, low, size)
│   │   ├── BreakoutSignal.ts       # Сигнал пробоя
│   │   └── index.ts
│   ├── enums/
│   │   ├── StrategyState.ts        # IDLE, RANGE_DEFINED, BREAKOUT_DETECTED, etc.
│   │   ├── TradeDirection.ts       # LONG / SHORT
│   │   └── index.ts
│   └── interfaces/
│       ├── IExchange.ts            # Контракт для бирж
│       ├── IIndicatorEngine.ts     # Контракт для индикаторов
│       ├── IMarketRegimeFilter.ts  # Контракт для фильтра рынка
│       ├── IRangeDetector.ts       # Контракт для определения диапазона
│       ├── IBreakoutDetector.ts    # Контракт для пробоя
│       ├── IPullbackValidator.ts   # Контракт для валидации отката
│       ├── IRiskEngine.ts          # Контракт для риск-менеджмента
│       ├── IStateMachine.ts        # Контракт для state machine
│       └── index.ts
│
├── infrastructure/                  # Внешние зависимости (API, DB)
│   ├── exchanges/
│   │   ├── bybit/
│   │   │   ├── BybitExchangeAdapter.ts      # Реализация IExchange для Bybit
│   │   │   ├── BybitCandleMapper.ts         # Маппер Bybit → Candle
│   │   │   ├── types/
│   │   │   │   └── BybitTypes.ts            # Типы API Bybit
│   │   │   └── index.ts
│   │   ├── binance/                         # Будущее
│   │   │   └── (аналогично Bybit)
│   │   └── paper-trading/
│   │       ├── PaperTradingExchange.ts      # Имитация торговли для бектеста
│   │       └── index.ts
│   └── database/
│       ├── repositories/
│       │   ├── CandleRepository.ts          # CRUD для свечей (Prisma)
│       │   ├── TradeRepository.ts           # CRUD для сделок (Prisma)
│       │   └── index.ts
│       └── prisma/
│           └── schema.prisma
│
├── application/                     # Use cases и сервисы
│   ├── services/
│   │   ├── indicators/
│   │   │   ├── IndicatorEngine.ts           # ATR, ADX, VWAP, SMA
│   │   │   └── index.ts
│   │   ├── market/
│   │   │   ├── MarketRegimeFilter.ts        # Фильтр ADX и волатильности
│   │   │   └── index.ts
│   │   ├── detection/
│   │   │   ├── RangeDetector.ts             # Определение диапазона (30 свечей)
│   │   │   ├── BreakoutDetector.ts          # Определение пробоя
│   │   │   └── index.ts
│   │   ├── validation/
│   │   │   ├── PullbackValidator.ts         # Валидация отката
│   │   │   └── index.ts
│   │   ├── risk/
│   │   │   ├── RiskEngine.ts                # Риск-менеджмент (1%, kill switch)
│   │   │   └── index.ts
│   │   └── state/
│   │       ├── StateMachine.ts              # State machine с валидацией
│   │       └── index.ts
│   ├── strategies/
│   │   ├── RangeBreakPullbackStrategy.ts    # Главный оркестратор стратегии
│   │   └── index.ts
│   └── use-cases/
│       ├── RunBacktest.ts                   # UseCase: запуск бектеста
│       ├── RunLiveTrading.ts                # UseCase: запуск live торговли
│       └── index.ts
│
├── presentation/                    # CLI, API (будущее)
│   └── cli/
│       ├── BacktestCommand.ts               # CLI команда для бектеста
│       ├── LiveCommand.ts                   # CLI команда для live
│       └── index.ts
│
├── config/                          # Конфигурация
│   ├── inversify.config.ts                  # DI контейнер (Inversify)
│   ├── strategy.config.ts                   # Параметры стратегии
│   └── index.ts
│
├── shared/                          # Утилиты
│   ├── logger/
│   │   ├── Logger.ts                        # Логирование
│   │   └── index.ts
│   └── utils/
│       └── TimeframeUtils.ts
│
└── index.ts                         # Entry point

prisma/
└── schema.prisma                   # Схема БД (SQLite)

tests/
├── unit/                           # Юнит-тесты
├── integration/                    # Интеграционные тесты
└── e2e/                            # E2E тесты

package.json
tsconfig.json
.env
.gitignore
README.md
```

---

## 🏗️ Архитектурные принципы

### **1. Clean Architecture (Слоистая архитектура)**

```
Domain Layer (Core)
    ↑
Application Layer (Use Cases)
    ↑
Infrastructure Layer (External Dependencies)
    ↑
Presentation Layer (CLI/API)
```

**Domain Layer** не знает о деталях реализации (БД, API) — только интерфейсы.

**Infrastructure Layer** реализует интерфейсы Domain Layer (адаптеры для бирж, БД).

### **2. SOLID Principles**

- ✅ **S**: Каждый класс имеет одну ответственность
- ✅ **O**: Легко добавить новую биржу без изменения кода
- ✅ **L**: Все адаптеры бирж взаимозаменяемы
- ✅ **I**: Интерфейсы специфичны (не god-interfaces)
- ✅ **D**: Зависимости через интерфейсы (DI)

### **3. Dependency Injection (Inversify)**

Все зависимости инжектятся через контейнер:

```typescript
const container = createContainer('backtest');
const strategy = container.get<RangeBreakPullbackStrategy>(TYPES.Strategy);
```

---

## 🎯 State Machine

Стратегия основана на **строгой state machine**:

```
IDLE → RANGE_DEFINED → BREAKOUT_DETECTED → 
WAIT_PULLBACK → ENTRY_PLACED → IN_POSITION → EXIT → RESET
```

### **Правила переходов:**

- **IDLE** → только **RANGE_DEFINED** (когда рынок валиден)
- **RANGE_DEFINED** → **BREAKOUT_DETECTED** (пробой диапазона)
- **BREAKOUT_DETECTED** → **WAIT_PULLBACK** (ждём откат)
- **WAIT_PULLBACK** → **ENTRY_PLACED** (валидный откат + паттерн)
- **ENTRY_PLACED** → **IN_POSITION** (ордер исполнен)
- **IN_POSITION** → **EXIT** (TP/SL достигнут)
- Из любого состояния → **RESET** (kill switch)

---

## 📊 Логика стратегии

### **1. Таймфреймы**

- **5m** — структура (диапазон, пробой, индикаторы)
- **1m** — вход (откат, паттерны)

### **2. Фильтр рынка (5m)**

```typescript
ADX ∈ [18, 35]
ATR/Close ∈ [0.15%, 0.6%]
```

### **3. Определение диапазона (5m)**

```typescript
range = {
  high: max(last 30 candles),
  low: min(last 30 candles),
  size: high - low
}

// Валидация:
range.size >= 1.2 * ATR
range.size <= 3.5 * ATR
```

### **4. Пробой (5m)**

**LONG:**
```typescript
close > range.high + 0.1 * ATR
body >= 60% candle
volume > SMA(volume, 20)
```

**SHORT:** зеркально

### **5. Откат (1m)**

```typescript
pullbackDepth <= 50% impulse
price near range.high OR vwap
pinbar OR engulfing pattern
```

### **6. Вход (1m)**

- LIMIT ордер
- SL = low pullback (для LONG)
- TP = 1.5–2R

### **7. Риск**

```typescript
risk = 1% per trade
position_size = (balance * 0.01) / stop_distance
max_daily_loss = 2%
max_consecutive_losses = 2
```

---

## 🚀 Использование

### **1. Установка**

```bash
npm install
npx prisma generate
npx prisma migrate dev
```

### **2. Конфигурация**

Создайте `.env`:

```env
DATABASE_URL="file:./dev.db"
BYBIT_API_KEY=your_key
BYBIT_API_SECRET=your_secret
BYBIT_TESTNET=true
```

### **3. Запуск бектеста**

```bash
npm run dev -- backtest \
  --symbol BTCUSDT \
  --start-date 2024-01-01 \
  --end-date 2024-01-31 \
  --balance 10000
```

### **4. Запуск live торговли**

```bash
npm run dev -- live \
  --symbol BTCUSDT \
  --tick-interval 5000
```

---

## 🔄 Как добавить новую биржу

### Пример: Binance

**1. Создать файлы:**

```
src/infrastructure/exchanges/binance/
├── BinanceExchangeAdapter.ts
├── BinanceCandleMapper.ts
├── types/
│   └── BinanceTypes.ts
└── index.ts
```

**2. Реализовать `IExchange`:**

```typescript
@injectable()
export class BinanceExchangeAdapter implements IExchange {
    async getCandles(symbol: string, timeframe: string): Promise<Candle[]> {
        // Binance API call
        const rawData = await fetchBinanceKlines(symbol, timeframe);
        return BinanceCandleMapper.toDomainArray(rawData);
    }
    
    // ... остальные методы
}
```

**3. Зарегистрировать в DI:**

```typescript
// config/inversify.config.ts
container.bind<IExchange>(TYPES.IExchange).to(BinanceExchangeAdapter);
```

Готово! Вся стратегия будет работать с Binance.

---

## 🧪 Тестирование

### **Unit тесты (сервисы):**

```bash
npm test -- indicators/IndicatorEngine.test.ts
npm test -- market/MarketRegimeFilter.test.ts
```

### **Integration тесты (стратегия):**

```bash
npm test -- strategies/RangeBreakPullbackStrategy.test.ts
```

### **E2E тесты (backtest):**

```bash
npm test -- e2e/backtest.test.ts
```

---

## 📈 Backtest Data Flow

```
1. RunBacktest.execute()
   ↓
2. Load candles (DB or API)
   ↓
3. CandleRepository.getCandles() OR Exchange.getCandles()
   ↓
4. For each tick:
   - Strategy.processTick(candles5m, candles1m)
   - State machine transitions
   - Place orders (PaperTradingExchange)
   ↓
5. TradeRepository.saveTrade() / closeTrade()
   ↓
6. Calculate stats
   ↓
7. Return BacktestResult
```

---

## 🔧 Конфигурация стратегии

```typescript
// config/strategy.config.ts
export const StrategyConfig = {
    // Market regime
    adx: { min: 18, max: 35 },
    volatility: { minPercent: 0.15, maxPercent: 0.6 },
    
    // Range detection
    range: { window: 30, minSizeMultiplier: 1.2, maxSizeMultiplier: 3.5 },
    
    // Breakout
    breakout: { atrMultiplier: 0.1, minBodyPercent: 60, volumePeriod: 20 },
    
    // Pullback
    pullback: { maxDepthPercent: 50, maxWaitCandles: 10 },
    
    // Risk
    risk: { riskPercentPerTrade: 1, maxDailyLossPercent: 2, rrRatio: 1.5 },
    
    // Limits
    limits: { maxTradesPerDay: 5, maxPositionTime: 30 }
};
```

---

## 📚 Основные классы

### **Domain Layer**

| Класс | Описание |
|-------|----------|
| `Candle` | Entity свечи (OHLCV) |
| `Position` | Entity позиции |
| `MarketRange` | Value object диапазона |
| `BreakoutSignal` | Value object пробоя |

### **Application Layer**

| Класс | Описание |
|-------|----------|
| `IndicatorEngine` | Расчёт индикаторов (ATR, ADX, VWAP, SMA) |
| `MarketRegimeFilter` | Фильтр валидности рынка |
| `RangeDetector` | Определение диапазона |
| `BreakoutDetector` | Определение пробоя |
| `PullbackValidator` | Валидация отката |
| `RiskEngine` | Риск-менеджмент |
| `StateMachine` | State machine |
| `RangeBreakPullbackStrategy` | Главный оркестратор |

### **Infrastructure Layer**

| Класс | Описание |
|-------|----------|
| `BybitExchangeAdapter` | Адаптер для Bybit API |
| `PaperTradingExchange` | Симуляция торговли (backtest) |
| `CandleRepository` | CRUD для свечей (Prisma) |
| `TradeRepository` | CRUD для сделок (Prisma) |

---

## 🎨 Dependency Injection Map

```
RangeBreakPullbackStrategy
    ├── IExchange (BybitExchangeAdapter | PaperTradingExchange)
    ├── IIndicatorEngine (IndicatorEngine)
    ├── IMarketRegimeFilter (MarketRegimeFilter)
    │   └── IIndicatorEngine
    ├── IRangeDetector (RangeDetector)
    ├── IBreakoutDetector (BreakoutDetector)
    ├── IPullbackValidator (PullbackValidator)
    ├── IRiskEngine (RiskEngine)
    └── IStateMachine (StateMachine)
```

---

## ⚠️ Critical Notes

1. **5m меняет state, 1m только валидирует**
2. **Range замораживается после пробоя**
3. **Все переходы state machine валидируются**
4. **НИКОГДА не используйте localStorage в artifacts**
5. **Только CLOSED candles (confirm=true)**

---

## 📝 TODO

- [ ] Binance adapter
- [ ] WebSocket streaming для live режима
- [ ] Position Manager (для управления открытыми позициями)
- [ ] Execution Engine (для размещения LIMIT ордеров)
- [ ] REST API (для мониторинга)
- [ ] Grafana dashboard
- [ ] Telegram бот для алертов

---

## 📜 License

MIT

---

## 🤝 Contributing

Pull requests welcome. For major changes, please open an issue first.

---

**Версия:** 1.0.0  
**Автор:** Range Break Strategy Team  
**Дата:** 2026-01-10