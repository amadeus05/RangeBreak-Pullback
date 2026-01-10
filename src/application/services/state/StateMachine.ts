import { injectable } from 'inversify';
import { IStateMachine } from '../../../domain/interfaces/IStateMachine';
import { StrategyState } from '../../../domain/enums/StrategyState';

interface StateTransition {
    state: StrategyState;
    timestamp: number;
    reason: string;
}

@injectable()
export class StateMachine implements IStateMachine {
    private currentState: StrategyState = StrategyState.IDLE;
    private stateHistory: StateTransition[] = [];

    getCurrentState(): StrategyState {
        return this.currentState;
    }

    transition(newState: StrategyState, reason: string): void {
        if (!this.canTransition(newState)) {
            console.warn(`Invalid transition from ${this.currentState} to ${newState}`);
            return;
        }

        console.log(`State transition: ${this.currentState} → ${newState} (${reason})`);
        
        this.stateHistory.push({
            state: this.currentState,
            timestamp: Date.now(),
            reason
        });

        this.currentState = newState;
    }

    canTransition(newState: StrategyState): boolean {
        const validTransitions: Record<StrategyState, StrategyState[]> = {
            [StrategyState.IDLE]: [StrategyState.RANGE_DEFINED],
            [StrategyState.RANGE_DEFINED]: [StrategyState.BREAKOUT_DETECTED, StrategyState.RESET],
            [StrategyState.BREAKOUT_DETECTED]: [StrategyState.WAIT_PULLBACK, StrategyState.RESET],
            [StrategyState.WAIT_PULLBACK]: [StrategyState.ENTRY_PLACED, StrategyState.RESET],
            [StrategyState.ENTRY_PLACED]: [StrategyState.IN_POSITION, StrategyState.RESET],
            [StrategyState.IN_POSITION]: [StrategyState.EXIT, StrategyState.RESET],
            [StrategyState.EXIT]: [StrategyState.RESET],
            [StrategyState.RESET]: [StrategyState.IDLE]
        };

        return validTransitions[this.currentState]?.includes(newState) ?? false;
    }

    reset(): void {
        this.transition(StrategyState.RESET, 'Manual reset');
        this.transition(StrategyState.IDLE, 'Reset complete');
    }

    getHistory(): StateTransition[] {
        return [...this.stateHistory];
    }
}