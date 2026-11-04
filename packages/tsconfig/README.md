# @agri/tsconfig

TypeScript 编译配置基座。全工程以 `extends` 方式引用，不通过依赖字段声明，因此不进入运行期产物。

## 预设与适用对象

| 预设文件 | 适用对象 | 关键内容 |
| --- | --- | --- |
| `base.json` | 全部包与服务 | 严格模式、目标版本、模块解析、源码映射 |
| `library.json` | 公共包 | 声明文件产出、composite 工程引用、输出目录 |
| `nest.json` | 服务工程 | 装饰器支持、依赖注入元数据 |
| `vue.json` | 前端工程 | 浏览器目标、模板类型检查 |
| `strict.json` | 需要最严校验的包 | 在基座之上追加未使用项与兜底检查 |

## 引用方式

```json
{
  "extends": "@agri/tsconfig/library.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*.ts"]
}
```

## 约束

- 基座预设不得放宽：子预设只能收紧检查，不能关闭基座中已开启的严格选项。
- 路径别名只用于包内相对路径简化，不用于跨包引用；跨包一律走包名。
- 三项最容易被认为「过于严格」的选项（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noFallthroughCasesInSwitch`）必须保留，它们拦下的是农业业务中最常见的越界取值、误清空字段与状态穿透三类错误。
