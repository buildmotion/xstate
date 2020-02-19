import { toArray, isBuiltInEvent, toSCXMLEvent } from './utils';
import {
  Event,
  StateValue,
  MachineOptions,
  EventObject,
  StateSchema,
  MachineConfig,
  SCXML,
  Typestate,
  StateTransition
} from './types';
import { State } from './State';

import { toActionObject } from './actions';
import { IS_PRODUCTION } from './environment';
import { STATE_DELIMITER } from './constants';
import { getConfiguration, getChildren, getAllStateNodes } from './stateUtils';
import {
  getStateNodeById,
  getInitialState,
  getStateNodes,
  transitionNode,
  resolveStateValue,
  resolveTransition
} from './stateUtils';
import { StateNode } from './StateNode';

export const NULL_EVENT = '';
export const STATE_IDENTIFIER = '#';
export const WILDCARD = '*';

const createDefaultOptions = <TContext>(
  context: TContext
): MachineOptions<TContext, any> => ({
  actions: {},
  guards: {},
  services: {},
  activities: {},
  delays: {},
  context
});

function resolveContext<TContext>(
  context: TContext,
  partialContext?: Partial<TContext>
): TContext {
  if (context === undefined) {
    return context;
  }

  return {
    ...context,
    ...partialContext
  };
}

export class MachineNode<
  TContext = any,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject,
  TTypestate extends Typestate<TContext> = any
> extends StateNode<TContext, TStateSchema, TEvent> {
  public context: TContext;
  /**
   * The machine's own version.
   */
  public version?: string;

  public parent = undefined;
  public strict: boolean;

  /**
   * The string delimiter for serializing the path to a string. The default is "."
   */
  public delimiter: string;

  public options: MachineOptions<TContext, TEvent>;

  public __xstatenode: true = true;

  constructor(
    /**
     * The raw config used to create the machine.
     */
    public config: MachineConfig<TContext, TStateSchema, TEvent>,
    options?: Partial<MachineOptions<TContext, TEvent>>
  ) {
    super(config, {
      _key: config.id || '(machine)'
    });
    this.options = Object.assign(
      createDefaultOptions(config.context!),
      options
    );
    this.context = resolveContext<TContext>(
      config.context as TContext,
      this.options.context
    );
    this.key = this.config.key || this.config.id || '(machine)';
    this.machine = this;
    this.path = [];
    this.delimiter = this.config.delimiter || STATE_DELIMITER;
    this.version = this.config.version;

    // Document order
    let order = 0;

    function dfs(stateNode: StateNode<TContext, any, TEvent>): void {
      stateNode.order = order++;

      for (const child of getChildren(stateNode)) {
        dfs(child);
      }
    }

    dfs(this);

    this.strict = !!this.config.strict;

    this.entry = toArray(this.config.entry).map(action =>
      toActionObject(action)
    );

    this.exit = toArray(this.config.exit).map(action => toActionObject(action));
    this.meta = this.config.meta;
    this.transition = this.transition.bind(this);
  }

  private _init(): void {
    if (this.__cache.transitions) {
      return;
    }
    getAllStateNodes(this).forEach(stateNode => stateNode.on);
  }

  /**
   * Clones this state machine with custom options and context.
   *
   * @param options Options (actions, guards, activities, services) to recursively merge with the existing options.
   * @param context Custom context (will override predefined context)
   */
  public withConfig(
    options: Partial<MachineOptions<TContext, TEvent>>
  ): MachineNode<TContext, TStateSchema, TEvent> {
    const { actions, activities, guards, services, delays } = this.options;

    return new MachineNode(this.config, {
      actions: { ...actions, ...options.actions },
      activities: { ...activities, ...options.activities },
      guards: { ...guards, ...options.guards },
      services: { ...services, ...options.services },
      delays: { ...delays, ...options.delays },
      context: resolveContext(this.context, options.context)
    });
  }

  /**
   * Clones this state machine with custom `context`.
   *
   * The `context` provided can be partial `context`, which will be combined with the original `context`.
   *
   * @param context Custom context (will override predefined context, not recursive)
   */
  public withContext(
    context: Partial<TContext>
  ): MachineNode<TContext, TStateSchema, TEvent> {
    return new MachineNode({
      ...this.config,
      context: resolveContext(this.context, context)
    });
  }

  /**
   * Resolves the given `state` to a new `State` instance relative to this machine.
   *
   * This ensures that `.events` and `.nextEvents` represent the correct values.
   *
   * @param state The state to resolve
   */
  public resolveState(state: State<TContext, TEvent>): State<TContext, TEvent> {
    const configuration = Array.from(
      getConfiguration([], getStateNodes(this, state.value))
    );
    return new State({
      ...state,
      value: resolveStateValue(this, state.value),
      configuration
    });
  }

  /**
   * Determines the next state given the current `state` and sent `event`.
   *
   * @param state The current State instance or state value
   * @param event The event that was sent at the current state
   * @param context The current context (extended state) of the current state
   */
  public transition(
    state: StateValue | State<TContext, TEvent> = this.initialState,
    event: Event<TEvent> | SCXML.Event<TEvent>
  ): State<TContext, TEvent, TStateSchema, TTypestate> {
    const _event = toSCXMLEvent(event);
    let currentState: State<TContext, TEvent>;

    if (state instanceof State) {
      currentState = state;
    } else {
      const resolvedStateValue = resolveStateValue(this, state);
      const resolvedContext = this.machine.context!;

      currentState = this.resolveState(
        State.from<TContext, TEvent>(resolvedStateValue, resolvedContext)
      );
    }

    if (!IS_PRODUCTION && _event.name === WILDCARD) {
      throw new Error(`An event cannot have the wildcard type ('${WILDCARD}')`);
    }

    if (this.strict) {
      if (!this.events.includes(_event.name) && !isBuiltInEvent(_event.name)) {
        throw new Error(
          `Machine '${this.id}' does not accept event '${_event.name}'`
        );
      }
    }

    const stateTransition: StateTransition<TContext, TEvent> = transitionNode(
      this,
      currentState.value,
      currentState,
      _event
    ) || {
      transitions: [],
      entrySet: []
    };

    return resolveTransition(this, stateTransition, currentState, _event);
  }

  /**
   * The initial State instance, which includes all actions to be executed from
   * entering the initial state.
   */
  public get initialState(): State<TContext, TEvent, TStateSchema, TTypestate> {
    this._init();
    const { initialStateValue } = this;

    if (!initialStateValue) {
      throw new Error(
        `Cannot retrieve initial state from simple state '${this.id}'.`
      );
    }

    return getInitialState(this, initialStateValue);
  }

  public getStateNodeById(id: string): StateNode<TContext, any, TEvent> {
    return getStateNodeById(this, id);
  }
}
