import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import type { ModuleMetadata, Provider, Type } from "@nestjs/common";

/**
 * 测试模块构造器。
 *
 * 把测试用模块的声明方式收敛到一处，避免每个测试文件各写一份装配代码；
 * 覆盖项集中登记，也便于审阅「测试究竟替换了哪些依赖」。
 */
export class TestModuleBuilder {
  private readonly imports: NonNullable<ModuleMetadata["imports"]> = [];

  private readonly providers: Provider[] = [];

  private readonly overrides = new Map<unknown, unknown>();

  /** 创建构造器 */
  static create(): TestModuleBuilder {
    return new TestModuleBuilder();
  }

  /** 追加导入模块 */
  withImports(modules: NonNullable<ModuleMetadata["imports"]>): this {
    this.imports.push(...modules);
    return this;
  }

  /** 追加提供者 */
  withProviders(providers: Provider[]): this {
    this.providers.push(...providers);
    return this;
  }

  /** 以给定值替换某个令牌的依赖 */
  withOverride(token: unknown, value: unknown): this {
    this.overrides.set(token, value);
    return this;
  }

  /** 以实例替换某个类的依赖 */
  withMock<T>(type: Type<T>, value: Partial<T>): this {
    this.overrides.set(type, value);
    return this;
  }

  /**
   * 编译模块。
   * @returns 已编译的测试模块
   */
  async build(): Promise<TestingModule> {
    let builder = Test.createTestingModule({ imports: this.imports, providers: this.providers });
    for (const [token, value] of this.overrides) {
      builder = builder.overrideProvider(token as string).useValue(value);
    }
    const moduleRef = await builder.compile();
    return moduleRef;
  }
}

/**
 * 构造并编译测试模块，编译失败时抛出原始错误便于定位。
 * @param metadata 模块元数据
 * @returns 已编译的测试模块
 */
export async function buildTestModule(metadata: ModuleMetadata): Promise<TestingModule> {
  return Test.createTestingModule(metadata).compile();
}
