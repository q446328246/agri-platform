/**
 * 前端工程规则：单文件组件与模板相关。
 * 前端只复用契约与通用工具，不引入服务端能力包，故此处不启用依赖注入类规则。
 */
export const VUE_RULES = {
  "vue": {
    "multi-word-component-names": "error",
    "no-unused-vars": "error",
    "component-tags-order": ["error", { order: ["script", "template", "style"] }],
  },
};
