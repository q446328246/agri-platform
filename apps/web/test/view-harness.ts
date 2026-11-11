import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as Vue from "vue";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

/** 复用现有 Node Vitest：编译真实 SFC，运行真实 Vue 调度/条件渲染；不模拟浏览器布局。 */
export function evaluateTs(source: string, filename: string, imports: Record<string, unknown>) {
  const { outputText } = ts.transpileModule(source.replaceAll("import.meta.env", '({ VITE_TIANDITU_KEY: "test-key" })'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const module = { exports: {} as any };
  new Function("require", "module", "exports", outputText)((name: string) => {
    if (name.endsWith(".css")) return {};
    if (!(name in imports)) throw new Error(`Missing test dependency: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

export class TestNode {
  parent: TestNode | null = null;
  children: TestNode[] = [];
  props: Record<string, any> = {};
  constructor(public tag: string, public textContent = "") {}
  append(...nodes: TestNode[]) {
    nodes.forEach((node) => {
      node.parent = this;
      this.children.push(node);
    });
  }
  set innerHTML(_value: string) {
    throw new Error("Tooltips must use textContent, not HTML parsing");
  }
}

function detach(node: TestNode) {
  if (node.parent) {
    const index = node.parent.children.indexOf(node);
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = null;
  }
}

const renderer = Vue.createRenderer<TestNode, TestNode>({
  createElement: (tag) => new TestNode(tag),
  createText: (text) => new TestNode("#text", text),
  createComment: (text) => new TestNode("#comment", text),
  insert(node, parent, anchor) {
    detach(node);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    node.parent = parent;
  },
  remove: detach,
  setText: (node, text) => { node.textContent = text; },
  setElementText: (node, text) => { node.children = []; node.textContent = text; },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp: (node, key, _oldValue, value) => { node.props[key] = value; },
});

export function mountView(url: URL, imports: Record<string, unknown>) {
  const filename = fileURLToPath(url);
  const source = readFileSync(url, "utf8");
  const { descriptor } = parse(source, { filename });
  const script = compileScript(descriptor, { id: filename, genDefaultAs: "__component" });
  const template = compileTemplate({
    source: descriptor.template!.content, filename, id: filename,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  if (template.errors.length) throw new Error(String(template.errors));
  const { default: component } = evaluateTs(
    `${script.content}\n${template.code}\n__component.render = render;\nexport default __component;`,
    filename + ".ts", { vue: Vue, ...imports },
  );
  const app = renderer.createApp(component);
  // Element Plus 与图标仅作结构桩；不执行依赖真实 DOM 的组件内部行为。
  for (const [_, name] of source.matchAll(/<(el-[\w-]+|Plus|Search|Refresh|Delete|Download)\b/g)) {
    if (app.component(name!)) continue;
    app.component(name!, Vue.defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => Vue.h(name!, attrs, name === "el-table-column" ? [] : slots.default?.());
      },
    }));
  }
  app.directive("loading", {});
  app.mount(new TestNode("root"));
  return { state: (app as any)._instance.setupState, unmount: () => app.unmount() };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

export async function flushView() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Vue.nextTick();
}
