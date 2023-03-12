/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getBPMNActivity, getBPMNProcess, logger, parse, readFile } from '../utils';
import { IdentityOptions, Metadata, MethodOptions, NodeKey } from '../common';
import { Context, Status, State, Token } from '../context';
import { BPMNDefinition, BPMNProcess } from '../type';
import { Activity, Container } from '../core';
import { getActivity } from '../tools';
import { Execute } from './types';

const log = logger('workflow');

export interface ExecutionInterface {
  id?: string;
  factory?: () => any;
  handler?: any;
  context?: Context;
  data?: any;
  value?: any;
  node?: IdentityOptions;
  xml?: string;
  path?: string;
  schema?: BPMNDefinition;
  exec?: Partial<Execute>;
}

/**
 * It runs the activity, and returns the value and exception
 *
 * @param {any} target - any - The target object that contains the method to be executed.
 * @param {string} method - The name of the method to be executed.
 * @param {MethodOptions} options - MethodOptions
 *
 * @returns The value of the method, or the exception if there is one.
 */
function run(target: any, method: string, options: MethodOptions) {
  options.activity.token = options.token;
  options.activity.context = options.context;

  let value;
  let exception;

  try {
    options.token.status = Status.Running;
    options.context!.status = Status.Running;

    let outgoing: Activity[] | undefined;

    log.info(`Activity ${options.activity.id ?? options.activity.name} is running...`);

    if (!method) {
      log.warn(`Activity ${options.activity.id ?? options.activity.name} method is not defined.`);

      value = options.value;
      outgoing = options.activity.takeOutgoing();
    } else value = (target as any)[method](options);

    log.info(`Activity ${options.activity.id ?? options.activity.name} is completed.`);

    /* This is the code that is responsible for pausing the workflow token. */
    if (method && options.activity.id === options.token.state.ref)
      options.activity.takeOutgoing(undefined, { pause: true });

    if (options.activity.isEnd()) options.token.status = Status.Terminated;

    if (!outgoing?.length && !method && !options.activity.isEnd()) options.token.pause();
  } catch (error) {
    options.context!.status = Status.Failed;
    options.token.status = Status.Failed;
    exception = error;

    log.error(`Activity ${options.activity.id ?? options.activity.name} failed.`);
  }

  return { value, exception };
}

export class WorkflowJS {
  protected target!: any;

  protected context?: Context;
  protected process?: BPMNProcess;
  protected definition?: BPMNDefinition;

  /**
   * > The `build` function is a static function that returns a new instance of the `WorkflowJS` class
   *
   * @param {Execute} [exec] - Execute - This is the object that is passed to the workflow when it is
   * executed.
   *
   * @returns A new instance of the WorkflowJS class.
   */
  static build(exec?: Partial<Execute>): WorkflowJS {
    const workflow = new this();

    if (exec) {
      workflow.target = exec?.target;
      workflow.context = exec?.context;
      workflow.process = exec?.process;
      workflow.definition = exec?.definition;
    }

    return workflow;
  }

  /**
   * It executes a workflow
   *
   * @param {ExecutionInterface} options - ExecutionInterface
   *
   * @returns The return value is an object with the following properties:
   */
  public execute(options: ExecutionInterface): Execute {
    if (!this.target && options?.exec?.target) this.target = options.exec.target;
    if (!this.context && options?.exec?.context) this.context = options.exec.context;
    if (!this.process && options?.exec?.process) this.process = options.exec.process;
    if (!this.definition && options?.exec?.definition) this.definition = options.exec.definition;

    const { handler, factory, path, xml, schema } = options;

    if (!this.definition && options.id) this.definition = Container.get(options.id);

    if (!this.definition && schema) this.definition = schema;
    else if (!this.definition && xml) this.definition = parse(xml)['bpmn:definitions'];
    else if (!this.definition && path) this.definition = parse(readFile(path))['bpmn:definitions'];

    if (!this.target) {
      this.target = '$__metadata__' in this ? this : (factory ?? (() => undefined))() ?? handler;
    }
    if (!this.target) throw new Error('Target workflow not found');

    const metadata = (this.target as any).$__metadata__ as Metadata;
    const nodes = Reflect.getMetadata(NodeKey, this.target, '$__metadata__');

    this.definition = this.definition ?? Container.get(metadata.definition.id);
    if (!this.definition) throw new Error('Definition schema not found');

    log.info(`Definition %o is loaded.`, metadata.definition);

    this.process = this.process ?? getBPMNProcess(this.definition, metadata.process);
    if (!this.process) throw new Error('Process definition not found');

    log.info(`Process %o is loaded.`, metadata.process);

    const { context, data, value } = options;
    this.context = this.context ?? context ?? Context.build({ data, status: Status.Ready });

    if (!this.context?.status) this.context.status = Status.Ready;

    if ([Status.Completed, Status.Terminated].includes(this.context.status))
      throw new Error('Cannot execute workflow at completed or terminated state');

    if (this.context.status !== Status.Ready) this.context.resume();
    if (!this.context.isReady()) throw new Error('Context is not ready to consume');

    /* Checking if the options has a node, if it does, it will get the activity from the process. If it
    does not, it will check if the context has tokens. If it does not, it will get the start event
    from the process. If it does, it will throw an error. */
    let activity: Activity | undefined;
    if (options?.node) {
      activity = getActivity(this.process, getBPMNActivity(this.process, options.node));
    } else if (!this.context.tokens.length) {
      if (!this.process['bpmn:startEvent'] || this.process['bpmn:startEvent'].length !== 1)
        throw new Error('Start event is not defined in process or have more than one start event');

      activity = getActivity(this.process, {
        key: 'bpmn:startEvent',
        activity: this.process['bpmn:startEvent'][0],
      });
    }
    if (!activity) throw new Error('Node activity not found');

    /* Checking if the context has tokens. If it does not, it creates a new token and adds it to the
    context. If it does, it gets the last token from the context and resumes it. */
    let token: Token | undefined;
    if (this.context.tokens.length == 0) {
      const state = State.build(activity.id, { name: activity.name, value, status: Status.Ready });

      token = Token.build();

      token.push(state);

      this.context.addToken(token);
    } else {
      token = this.context.getTokens(activity.$)?.pop();

      if (token?.isPaused()) {
        token.resume();

        if (!token.isReady()) throw new Error('Token is not ready to consume');
      }
    }

    if (!token) throw new Error('Token not found');

    let node!: { identity: IdentityOptions; propertyName: string };

    if (activity.name) node = nodes[activity.name];
    if (!node && activity.id) node = nodes[activity.id];
    if (!node) throw new Error('Requested node not found');

    log.info(`Node %o is loaded.`, node);

    const runOptions: { method: string; options: MethodOptions } = {
      method: node.propertyName,
      options: { activity, token, value, data: data ?? this.context.data, context: this.context },
    };

    /* A loop that will run until the context status is not running. */
    do {
      const result = run(this.target, runOptions.method, runOptions.options);

      log.debug(`Result of ${runOptions.method} is ${result.value}`);

      if (result.exception) throw result.exception;

      if (this.context.status === Status.Running) {
        const next = this.context.next();

        log.info(`Next node is ${next?.name ?? next?.ref ?? 'undefined'}`);

        if (!next) break;

        runOptions.method = '';
        next.value = result.value;

        if (next.name) runOptions.method = nodes[next.name]?.propertyName ?? '';
        if (!runOptions.method) runOptions.method = nodes[next.ref]?.propertyName ?? '';

        log.info(`Next method is ${runOptions.method ?? 'undefined'}`);

        const token = this.context.getTokens({ id: next.ref })?.find((t) => t.status === Status.Ready);

        if (!token) throw new Error('Token not found at running stage');

        const activity = getActivity(this.process, getBPMNActivity(this.process, { id: next.ref }));

        log.info(`Next Activity is ${activity?.name ?? activity?.id ?? 'undefined'}`);

        runOptions.options = {
          token,
          activity,
          value: next.value,
          context: this.context,
          data: data ?? this.context.data,
        };
      }
    } while (this.context.status === Status.Running);

    /* Setting the status of the context to the appropriate status. */
    if (this.context.isPaused()) this.context.status = Status.Paused;
    else if (this.context.isCompleted()) this.context.status = Status.Completed;
    else if (this.context.isTerminated()) this.context.status = Status.Terminated;

    log.info(`Context status is ${this.context.status}`);

    return {
      target: this.target,
      context: this.context,
      process: this.process,
      definition: this.definition,
    };
  }
}
