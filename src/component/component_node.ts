import type { App, Env } from "../app/app";
import { BDom, VNode } from "../blockdom";
import { Component } from "./component";
import {
  Fiber,
  makeChildFiber,
  makeRootFiber,
  MountFiber,
  MountOptions,
  RootFiber,
  __internal__destroyed,
} from "./fibers";
import { handleError, fibersInError } from "./error_handling";
import { applyDefaultProps } from "./props_validation";
import { STATUS } from "./status";
import { applyStyles } from "./style";

export function component(
  name: string | typeof Component,
  props: any,
  key: string,
  ctx: ComponentNode,
  parent: any
): ComponentNode {
  let node: any = ctx.children[key];
  let isDynamic = typeof name !== "string";

  if (node) {
    if (node.status < STATUS.MOUNTED) {
      node.destroy();
      node = undefined;
    } else if (node.status === STATUS.DESTROYED) {
      node = undefined;
    }
  }
  if (isDynamic && node && node.component.constructor !== name) {
    node = undefined;
  }

  const parentFiber = ctx.fiber!;
  if (node) {
    node.updateAndRender(props, parentFiber);
  } else {
    // new component
    let C;
    if (isDynamic) {
      C = name;
    } else {
      C = parent.constructor.components[name as any];
      if (!C) {
        throw new Error(`Cannot find the definition of component "${name}"`);
      }
    }
    node = new ComponentNode(C, props, ctx.app, ctx);
    ctx.children[key] = node;

    const fiber = makeChildFiber(node, parentFiber);
    node.initiateRender(fiber);
  }
  return node;
}

// -----------------------------------------------------------------------------
//  Component VNode
// -----------------------------------------------------------------------------

let currentNode: ComponentNode | null = null;

export function getCurrent(): ComponentNode | null {
  return currentNode;
}

type LifecycleHook = Function;

export class ComponentNode<T extends typeof Component = any> implements VNode<ComponentNode> {
  el?: HTMLElement | Text | undefined;
  app: App;
  fiber: Fiber | null = null;
  component: InstanceType<T>;
  bdom: BDom | null = null;
  status: STATUS = STATUS.NEW;

  renderFn: Function;
  parent: ComponentNode | null;
  level: number;
  childEnv: Env;
  children: { [key: string]: ComponentNode } = Object.create(null);
  slots: any = {};
  refs: any = {};

  willStart: LifecycleHook[] = [];
  willUpdateProps: LifecycleHook[] = [];
  willUnmount: LifecycleHook[] = [];
  mounted: LifecycleHook[] = [];
  willPatch: LifecycleHook[] = [];
  patched: LifecycleHook[] = [];
  destroyed: LifecycleHook[] = [];

  constructor(C: T, props: any, app: App, parent?: ComponentNode) {
    currentNode = this;
    this.app = app;
    this.parent = parent || null;
    this.level = parent ? parent.level + 1 : 0;
    applyDefaultProps(props, C);
    const env = (parent && parent.childEnv) || app.env;
    this.childEnv = env;
    this.component = new C(props, env, this) as any;
    this.renderFn = app.getTemplate(C.template).bind(this.component, this.component, this);
    if (C.style) {
      applyStyles(C);
    }
    this.component.setup();
  }

  mountComponent(target: any, options?: MountOptions): Promise<InstanceType<T>> {
    const fiber = new MountFiber(this, target, options);
    this.app.scheduler.addFiber(fiber);
    this.initiateRender(fiber);
    return fiber.promise.then(() => this.component);
  }

  async initiateRender(fiber: Fiber | MountFiber) {
    if (this.mounted.length) {
      fiber.root.mounted.push(fiber);
    }
    const component = this.component;
    try {
      await Promise.all(this.willStart.map((f) => f.call(component)));
    } catch (e) {
      handleError(this, e as Error);
      return;
    }
    if (this.status === STATUS.NEW && this.fiber === fiber) {
      this._render(fiber);
    }
  }

  async render() {
    let fiber = this.fiber;
    if (fiber && !fiber.bdom && !fibersInError.has(fiber)) {
      return fiber.root.promise;
    }
    if (!this.bdom && !this.fiber) {
      // should find a way to return the future mounting promise
      return;
    }
    fiber = makeRootFiber(this);
    this.app.scheduler.addFiber(fiber);
    await Promise.resolve();
    if (this.status === STATUS.DESTROYED) {
      return;
    }
    if (this.fiber === fiber) {
      this._render(fiber);
    }
    return fiber.root.promise;
  }

  _render(fiber: Fiber | RootFiber) {
    try {
      fiber.bdom = this.renderFn();
      fiber.root.counter--;
    } catch (e) {
      handleError(this, e as Error);
    }
  }

  destroy() {
    if (this.status === STATUS.MOUNTED) {
      callWillUnmount(this);
      this.bdom!.remove();
    }
    callDestroyed(this);

    function callWillUnmount(node: ComponentNode) {
      const component = node.component;
      for (let cb of node.willUnmount) {
        cb.call(component);
      }
      for (let child of Object.values(node.children)) {
        if (child.status === STATUS.MOUNTED) {
          callWillUnmount(child);
        }
      }
    }

    function callDestroyed(node: ComponentNode) {
      const component = node.component;
      node.status = STATUS.DESTROYED;
      for (let child of Object.values(node.children)) {
        callDestroyed(child);
      }
      for (let cb of node.destroyed) {
        cb.call(component);
      }
    }
  }

  async updateAndRender(props: any, parentFiber: Fiber) {
    // update
    const fiber = makeChildFiber(this, parentFiber);
    if (this.willPatch.length) {
      parentFiber.root.willPatch.push(fiber);
    }
    if (this.patched.length) {
      parentFiber.root.patched.push(fiber);
    }
    const component = this.component;
    applyDefaultProps(props, component.constructor as any);
    const prom = Promise.all(this.willUpdateProps.map((f) => f.call(component, props)));
    await prom;
    if (fiber !== this.fiber) {
      return;
    }
    this.component.props = props;
    this._render(fiber);
  }

  // ---------------------------------------------------------------------------
  // Block DOM methods
  // ---------------------------------------------------------------------------

  firstNode(): Node | undefined {
    const bdom = this.bdom;
    return bdom ? bdom.firstNode() : undefined;
  }

  mount(parent: HTMLElement, anchor: ChildNode) {
    const bdom = this.fiber!.bdom!;
    this.bdom = bdom;
    bdom.mount(parent, anchor);
    this.status = STATUS.MOUNTED;
    this.fiber!.appliedToDom = true;
    this.fiber = null;
  }

  moveBefore(other: ComponentNode | null, afterNode: Node | null) {
    this.bdom!.moveBefore(other ? other.bdom : null, afterNode);
  }

  patch() {
    this.bdom!.patch(this!.fiber!.bdom!, false);
    this.fiber!.appliedToDom = true;
    this.fiber = null;
  }

  beforeRemove() {
    visitRemovedNodes(this);
  }

  remove() {
    this.bdom!.remove();
  }
}

function visitRemovedNodes(node: ComponentNode) {
  if (node.status === STATUS.MOUNTED) {
    const component = node.component;
    for (let cb of node.willUnmount) {
      cb.call(component);
    }
  }
  for (let child of Object.values(node.children)) {
    visitRemovedNodes(child);
  }
  node.status = STATUS.DESTROYED;
  if (node.destroyed.length) {
    __internal__destroyed.push(node);
  }
}