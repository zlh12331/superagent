╔══════════════════════════════════════════════════════════════════════════════╗
║          TypeScript 项目开发规范 — AI 编码专用版（全显式 · 零歧义）           ║
╚══════════════════════════════════════════════════════════════════════════════╝

【文档定位】
本规范供 AI 编码代理（AI Coding Agent）在生成、修改 TypeScript 代码时
严格遵循。与人类版规范的核心区别：

  1. 所有规则均为【强制】，不存在"建议""可选""视情况"。
  2. 人类可以凭经验省略的隐式要求，本规范全部显式写出。
  3. 人类可以按需开启部分严格选项，AI 必须全部开启，无例外。
  4. 每条规则附带可直接复制粘贴的精确配置或代码模板。
  5. 不存在"参考""大致""酌情"等模糊措辞 — 一切都是确定指令。

【AI 执行原则】
  - 原则 A：本规范中的每一条都是硬性约束，违反任一条等于产生缺陷代码。
  - 原则 B：当本规范与项目现有代码冲突时，以本规范为准并向用户说明。
  - 原则 C：如果某场景本规范未覆盖，选择最严格的做法并向用户确认。
  - 原则 D：禁止使用"我觉得""可能""大概"等主观判断 — 一切由规则决定。


================================================================================
  1. tsconfig.json — 全部严格选项开启（零例外）
================================================================================

AI 生成任何 TypeScript 项目时，必须使用以下完整 tsconfig.json 配置。
禁止省略任何选项，禁止将任何选项设为 false 或放宽。

────────────────────────────────────────────────────────────────
文件：tsconfig.json（根配置，适用于所有项目）
────────────────────────────────────────────────────────────────

{
  "compilerOptions": {

    /* === 目标与模块 === */
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],

    /* === 严格模式 — 全部开启，无一例外 === */
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,

    /* === 模块互操作 === */
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,

    /* === 声明文件 === */
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,

    /* === 解析 === */
    "resolveJsonModule": true,
    "skipLibCheck": true,

    /* === 输出 === */
    "noEmitOnError": true,
    "removeComments": false
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist"]
}

────────────────────────────────────────────────────────────────
逐项说明（AI 必须理解每一项的作用，不可机械复制）：
────────────────────────────────────────────────────────────────

  strict: true
    → 聚合启用以下 8 项，AI 禁止单独关闭任何一项：
      strictNullChecks          — null/undefined 不能赋值给非可空类型
      noImplicitAny             — 禁止隐式 any，所有参数必须有类型
      strictFunctionTypes       — 函数参数双向检查改为逆变检查
      strictBindCallApply       — bind/call/apply 参数必须类型匹配
      strictPropertyInitialization — 类属性必须在构造函数中初始化
      noImplicitThis            — 禁止 this 为隐式 any
      alwaysStrict              — 输出 "use strict"
      useUnknownInCatchVariables — catch 变量类型为 unknown

  noUncheckedIndexedAccess: true
    → arr[0] 的类型为 T | undefined，不是 T。
    → AI 在访问数组元素后必须进行 undefined 检查。

  exactOptionalPropertyTypes: true
    → { name?: string } 表示属性可以不存在，但不能显式设为 undefined。
    → AI 在设置可选属性时，必须先检查是否要设置，而非直接赋 undefined。

  verbatimModuleSyntax: true
    → 禁止隐式类型导入，必须使用 import type 显式标记。
    → AI 在导入仅用于类型的符号时，必须使用 import type。

  noUnusedLocals: true / noUnusedParameters: true
    → 禁止未使用的变量和参数。
    → AI 在重构时必须删除所有未使用的导入和变量。
    → 如果参数确实不需要但签名要求保留，使用下划线前缀 _param。

  noImplicitReturns: true
    → 函数所有代码路径必须显式 return。
    → AI 在编写 if/else 分支时，所有分支都必须有 return 语句。

  noFallthroughCasesInSwitch: true
    → switch case 必须以 break/return/throw 结尾。
    → AI 禁止编写穿透的 switch case。


================================================================================
  2. 编码风格 — 全部硬性规则
================================================================================

  规则 2.1  缩进：2 个空格，禁止 Tab。
  规则 2.2  行宽：每行不超过 100 字符，超出必须换行。
  规则 2.3  分号：每条语句必须以分号结尾。
  规则 2.4  引号：字符串用单引号 '，JSX 属性用双引号 "。
  规则 2.5  尾逗号：多行对象/数组/参数最后一个元素必须有逗号。

    const config = {
      host: 'localhost',
      port: 3000,
      timeout: 5000,  ← 必须有逗号
    };

  规则 2.6  花括号：if/for/while/switch 必须始终使用花括号 {}，
            即使只有一条语句。禁止单行 if。

    // ✗ 禁止
    if (x) doSomething();

    // ✓ 必须
    if (x) {
      doSomething();
    }

  规则 2.7  变量声明：const 优先，仅需要重新赋值时用 let，
            禁止使用 var。每条语句只声明一个变量。

  规则 2.8  箭头函数：匿名函数一律使用箭头函数 () => {}，
            禁止使用 function 关键字定义匿名函数。

  规则 2.9  数组创建：使用 [] 字面量，禁止 new Array()。
  规则 2.10 对象创建：使用 {} 字面量，禁止 new Object()。
  规则 2.11 字符串拼接：使用模板字符串 `...`，禁止用 + 拼接。

  规则 2.12 空格规则（必须严格遵守）：
    - 二元运算符两侧各一个空格：a + b, x === y
    - 逗号后一个空格：[1, 2, 3], { a: 1, b: 2 }
    - 冒号左侧无空格，右侧一个空格：{ key: value }
    - 函数参数列表中等号两侧不加空格：function fn(x: string = 'a')
    - 花括号内侧无空格（对象除外）：if (x) { 不是 if ( x ) {
    - 对象花括号内侧一个空格：{ key: value } 不是 {key: value}

  规则 2.13 空行规则：
    - 顶级函数和类定义前后各 2 个空行
    - 类内部方法之间 1 个空行
    - 逻辑块之间 1 个空行
    - 函数内部连续语句之间无空行


================================================================================
  3. 命名规范 — 全部硬性规则
================================================================================

  规则 3.1  类、接口、类型别名、枚举、装饰器 → PascalCase
            示例：UserService, HttpRequestConfig, RequestMethod

  规则 3.2  变量、参数、函数、方法、属性 → camelCase
            示例：getUserById, userName, isLoading

  规则 3.3  全局常量 → CONSTANT_CASE
            示例：MAX_RETRY_COUNT, DEFAULT_TIMEOUT_MS

  规则 3.4  布尔变量和返回布尔值的函数 → is/has/can/should 前缀
            示例：isAuthenticated, hasPermission, canEdit, shouldRetry

  规则 3.5  文件名 → kebab-case（小写加连字符）
            示例：user-service.ts, http-client.ts

  规则 3.6  泛型类型参数 → 单个大写字母或 PascalCase
            示例：T, K, V, Type, Item

  规则 3.7  禁止事项（全部硬性禁止，无例外）：
    - 禁止接口名以 I 开头（用 UserService 不用 IUserService）
    - 禁止私有成员以 _ 开头（TypeScript 有 private 关键字）
    - 禁止使用拼音命名
    - 禁止使用不透明缩写（tmp, buf, cnt, req, res 也不行，
      必须写完整：request, response, buffer, count, temporary）
    - 禁止数字后缀（data1, result2, user3）
    - 禁止单字母变量（循环索引 i, j, k 除外）
    - 禁止缩写视为非完整单词（用 loadHttpUrl 不用 loadHTTPURL，
      除非是平台标准如 XMLHttpRequest）

  规则 3.8  函数命名前缀约定：
    - 查询类：get_ / find_ / exists_（getUserId, findUserByEmail）
    - 操作类：动词开头（createOrder, deleteRecord, updateProfile）
    - 转换类：to_ / from_（toJson, fromDict）
    - 回调类：on_ / handle_（onClick, handleValidationError）
    - 断言类：is_ / has_ / can_ / should_（isAdmin, hasAccess）


================================================================================
  4. 类型系统 — 全部硬性规则
================================================================================

────────────────────────────────────────────────────────────────
规则 4.1  禁止使用 any（零容忍）
────────────────────────────────────────────────────────────────

  any 被完全禁止。如果确实不知道类型，使用 unknown 并进行类型缩小。

  // ✗ 绝对禁止
  function process(data: any): any { ... }

  // ✓ 必须这样
  function process(data: unknown): string {
    if (typeof data === 'string') {
      return data.toUpperCase();
    }
    throw new TypeError('Expected string');
  }

  如果 ESLint 报告 any 使用，AI 必须立即修复，禁止使用 @ts-ignore
  或 eslint-disable 绕过。

────────────────────────────────────────────────────────────────
规则 4.2  禁止使用大写原始类型包装
────────────────────────────────────────────────────────────────

  禁止：String, Number, Boolean, Symbol, Object, BigInt
  使用：string, number, boolean, symbol, object, bigint

────────────────────────────────────────────────────────────────
规则 4.3  函数参数必须显式标注类型
────────────────────────────────────────────────────────────────

  所有函数参数（包括箭头函数参数）必须有显式类型标注。
  不依赖上下文类型推断（contextual typing）。

  // ✗ 禁止 — 依赖上下文推断
  array.map((item) => item.name);

  // ✓ 必须 — 显式标注
  array.map((item: User): string => item.name);

  例外：当参数类型可从签名明确推断且为回调函数时（如 Promise.then
  的参数），可以省略，但 AI 必须在能确定类型时标注。

────────────────────────────────────────────────────────────────
规则 4.4  函数返回类型 — 公共 API 必须标注
────────────────────────────────────────────────────────────────

  所有 export 的函数必须显式标注返回类型。
  非 export 的内部函数可以省略返回类型（让推断工作）。

  // ✓ export 函数 — 返回类型必须标注
  export function getUserById(id: string): User | null { ... }

  // ✓ 内部函数 — 可省略
  function helper(value: string) { return value.trim(); }

────────────────────────────────────────────────────────────────
规则 4.5  interface vs type 选择规则（确定性决策）
────────────────────────────────────────────────────────────────

  AI 在定义类型时，按以下决策树选择，不允许凭感觉：

  判断条件 → 选择：
    1. 需要定义对象形状？                    → interface
    2. 需要声明合并？                        → interface
    3. 需要被 class implements？              → interface
    4. 需要联合类型（A | B）？                → type
    5. 需要交叉类型（A & B）？                → type
    6. 需要元组类型 [A, B]？                  → type
    7. 需要映射类型 / 条件类型？              → type
    8. 需要原始类型别名（type ID = string）？ → type
    9. 需要函数类型字面量？                   → type
   10. 以上都不是？                          → interface（默认）

────────────────────────────────────────────────────────────────
规则 4.6  可空类型标注
────────────────────────────────────────────────────────────────

  使用 T | null 或 T | undefined，不使用 Optional<T>。
  在 strict 模式下，null 和 undefined 是不同的类型，不能互换。

  - 值可能不存在 → 用 T | undefined（推荐）
  - 值被显式置空表示"无值" → 用 T | null
  - 两者都可能 → 用 T | null | undefined

  在 exactOptionalPropertyTypes 开启时：
    { name?: string } 表示属性可以不存在，但不能是 undefined
    { name: string | undefined } 表示属性必须存在，值可以是 undefined

────────────────────────────────────────────────────────────────
规则 4.7  数组类型标注
────────────────────────────────────────────────────────────────

  使用 T[] 语法，不使用 Array<T> 语法。

  // ✓
  const users: User[] = [];
  const matrix: number[][] = [];

  // ✗
  const users: Array<User> = [];

────────────────────────────────────────────────────────────────
规则 4.8  使用 never 实现穷尽性检查（必须）
────────────────────────────────────────────────────────────────

  所有 switch 语句处理联合类型时，default 分支必须使用 never 检查。

  type Status = 'pending' | 'active' | 'inactive';

  function getStatusMessage(status: Status): string {
    switch (status) {
      case 'pending':
        return '等待中';
      case 'active':
        return '活跃';
      case 'inactive':
        return '已停用';
      default: {
        // 穷尽性检查 — 如果 Status 新增成员，此处编译报错
        const _exhaustive: never = status;
        return _exhaustive;
      }
    }
  }

────────────────────────────────────────────────────────────────
规则 4.9  泛型三条铁律（必须全部遵守）
────────────────────────────────────────────────────────────────

  铁律 1：将类型参数下推 — 使用类型参数本身，不使用 extends any[]
          约束后返回。

  铁律 2：使用最少的类型参数 — 每个类型参数必须关联至少两个值。
          如果只出现一次，删除它。

  铁律 3：类型参数必须出现至少两次（函数签名中）。

  // ✗ 违反铁律 1 — 返回类型退化为 any
  function firstElement<T extends any[]>(arr: T) {
    return arr[0];
  }

  // ✓ 遵守铁律 1
  function firstElement<T>(arr: T[]): T | undefined {
    return arr[0];
  }

────────────────────────────────────────────────────────────────
规则 4.10  联合类型优先于函数重载
────────────────────────────────────────────────────────────────

  当函数接受多种参数类型时，使用联合类型而非重载。

  // ✗ 禁止
  function format(value: string): string;
  function format(value: number): string;
  function format(value: any): string { ... }

  // ✓ 必须
  function format(value: string | number): string { ... }

  仅当参数数量/结构不同（非仅类型不同）时才允许重载。

────────────────────────────────────────────────────────────────
规则 4.11  as 类型断言的限制
────────────────────────────────────────────────────────────────

  禁止使用 as any。
  禁止使用 as unknown as T 双重断言（除非有充分理由并注释说明）。
  优先使用类型守卫（type guard）而非断言。

  // ✗ 禁止
  const user = data as any;
  const user = data as unknown as User;

  // ✓ 优先使用类型守卫
  function isUser(data: unknown): data is User {
    return (
      typeof data === 'object' &&
      data !== null &&
      'id' in data &&
      'name' in data
    );
  }

  const user = isUser(data) ? data : null;

────────────────────────────────────────────────────────────────
规则 4.12  使用 readonly 标记不可变数据
────────────────────────────────────────────────────────────────

  所有函数参数中的数组使用 readonly 修饰。
  所有接口中表示不可变数据的属性使用 readonly。

  interface User {
    readonly id: string;
    readonly name: string;
  }

  function sum(numbers: readonly number[]): number {
    return numbers.reduce((a: number, b: number): number => a + b, 0);
  }

────────────────────────────────────────────────────────────────
规则 4.13  使用 satisfies 运算符进行类型验证
────────────────────────────────────────────────────────────────

  当需要验证对象是否满足某类型但保留最具体的字面量类型时，
  使用 satisfies 而非类型注解。

  const config = {
    host: 'localhost',
    port: 3000,
  } satisfies ServerConfig;
  // config.host 的类型是 'localhost'（字面量），不是 string

────────────────────────────────────────────────────────────────
规则 4.14  使用 Record 和 Map 的明确规则
────────────────────────────────────────────────────────────────

  键值对存储的决策规则（确定性）：

    1. 键是已知有限集合 → 使用 Record<KeyType, ValueType>
    2. 键是动态的、运行时生成的 → 使用 Map<KeyType, ValueType>
    3. 键是对象（非 string/number） → 使用 Map
    4. 需要插入顺序保证 → 使用 Map
    5. 频繁增删键值对 → 使用 Map

  禁止用普通对象 { [key: string]: T } 作为动态键值存储（原型污染风险）。


================================================================================
  5. 模块与导入 — 全部硬性规则
================================================================================

  规则 5.1  使用命名导出，禁止默认导出。

    // ✗ 禁止
    export default function getUser() { ... }

    // ✓ 必须
    export function getUser(): void { ... }

  规则 5.2  使用 import type 标记仅类型导入。

    // 仅类型
    import type { User, UserConfig } from './types';

    // 混合 — 内联 type 标记
    import { createUser, type User } from './user-service';

    // verbatimModuleSyntax: true 开启后，这是强制的。

  规则 5.3  禁止使用 namespace，使用 ES Module。
  规则 5.4  禁止 export let，使用 getter 函数替代。
  规则 5.5  禁止使用 require()，使用 import。
  规则 5.6  禁止使用 module.exports，使用 export。

  规则 5.7  导入顺序（必须按此顺序排列，组间空一行）：

    // 1. Node.js 标准库
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';

    // 2. 第三方库（按字母序）
    import express from 'express';
    import { z } from 'zod';

    // 3. 本地模块（按字母序）
    import { UserService } from './services/user-service';
    import { type User } from './types';

  规则 5.8  禁止循环依赖。AI 在创建模块时必须检查导入方向。
            如果发现 A 导入 B 且 B 导入 A，必须重构：
            将共享类型提取到第三个模块 C，让 A 和 B 都导入 C。

  规则 5.9  禁止使用 barrel files（index.ts 聚合导出）。
            每个模块从其源文件直接导入。

  规则 5.10 使用 .js 扩展名导入（当 moduleResolution 为 nodenext 时）。
            使用无扩展名导入（当 moduleResolution 为 bundler 时）。
            AI 必须根据项目 tsconfig 的 moduleResolution 决定。


================================================================================
  6. 函数设计 — 全部硬性规则
================================================================================

  规则 6.1  一个函数只做一件事。函数体不超过 40 行。
            超过 40 行必须拆分为子函数。

  规则 6.2  函数参数不超过 4 个。超过 4 个必须封装为对象参数。

    // ✗ 禁止
    function createUser(
      name: string,
      email: string,
      age: number,
      role: string,
      dept: string,
      active: boolean,
    ): User { ... }

    // ✓ 必须
    interface CreateUserOptions {
      name: string;
      email: string;
      age: number;
      role: string;
      dept: string;
      active: boolean;
    }

    function createUser(opts: CreateUserOptions): User { ... }

  规则 6.3  必填参数在前，可选参数在后。
  规则 6.4  禁止布尔参数控制函数行为。拆分为两个独立函数。

    // ✗ 禁止
    function processPayment(amount: number, isRefund: boolean): void { ... }

    // ✓ 必须
    function chargePayment(amount: number): void { ... }
    function refundPayment(amount: number): void { ... }

  规则 6.5  使用卫语句（提前返回），嵌套不超过 3 层。

    // ✓ 卫语句模式
    function getUser(id: string): User | null {
      if (!id) return null;           // 卫语句 1
      const user = db.find(id);
      if (!user) return null;         // 卫语句 2
      if (user.deleted) return null;  // 卫语句 3
      return user;                    // 主逻辑
    }

  规则 6.6  查询函数找不到返回 null，不抛异常。
            findUser 返回 User | null，不抛 NotFoundError。

  规则 6.7  纯函数优先。不依赖全局变量、当前时间、随机数。
            需要时间时，作为参数传入。

    // ✗ 禁止 — 依赖全局时间
    function isExpired(expiresAt: number): boolean {
      return Date.now() > expiresAt;
    }

    // ✓ 必须 — 时间通过参数注入
    function isExpired(expiresAt: number, now: number): boolean {
      return now > expiresAt;
    }

  规则 6.8  所有函数参数在入口处进行前置条件检查（防御性编程）。

    function divide(a: number, b: number): number {
      if (typeof a !== 'number' || typeof b !== 'number') {
        throw new TypeError('Arguments must be numbers');
      }
      if (b === 0) {
        throw new DivisionByZeroError('Cannot divide by zero');
      }
      return a / b;
    }

  规则 6.9  资源获取和释放在同一作用域，使用上下文管理器模式。

    // 使用 try/finally 确保资源释放
    const resource = acquireResource();
    try {
      useResource(resource);
    } finally {
      releaseResource(resource);
    }


================================================================================
  7. 错误处理 — 全部硬性规则
================================================================================

  规则 7.1  自定义错误类必须继承 Error，携带 code 和 statusCode。

    class AppError extends Error {
      constructor(
        message: string,
        public readonly code: string,
        public readonly statusCode: number = 500,
        public readonly isOperational: boolean = true,
      ) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
      }
    }

    // 具体错误类
    class ValidationError extends AppError {
      constructor(message: string) {
        super(message, 'VALIDATION_ERROR', 400);
      }
    }

    class NotFoundError extends AppError {
      constructor(resource: string) {
        super(`${resource} not found`, 'NOT_FOUND', 404);
      }
    }

  规则 7.2  catch 变量必须按 unknown 处理，进行类型缩小。

    try {
      await operation();
    } catch (error: unknown) {
      if (error instanceof AppError) {
        logger.error({ code: error.code, message: error.message });
        throw error;
      }
      if (error instanceof Error) {
        logger.error({ message: error.message, stack: error.stack });
        throw new AppError(error.message, 'INTERNAL_ERROR', 500);
      }
      logger.error({ error: String(error) });
      throw new AppError('Unknown error occurred', 'UNKNOWN', 500);
    }

  规则 7.3  禁止空 catch 块。每个 catch 必须至少记录日志。

    // ✗ 绝对禁止
    try { ... } catch { }

    // ✓ 必须
    try { ... } catch (error: unknown) {
      logger.error('Operation failed', { error });
    }

  规则 7.4  禁止用异常做流程控制。可预期失败使用 Result 类型。

    type Result<T, E = Error> =
      | { ok: true; value: T }
      | { ok: false; error: E };

    function parseUser(input: string): Result<User, ParseError> {
      try {
        const data = JSON.parse(input);
        return { ok: true, value: data as User };
      } catch {
        return { ok: false, error: new ParseError('Invalid JSON') };
      }
    }

    // 调用者必须处理两种情况
    const result = parseUser(input);
    if (!result.ok) {
      handleParseError(result.error);
      return;
    }
    useUser(result.value);

  规则 7.5  异常使用场景决策（确定性）：

    使用异常（throw）：  使用 Result 类型：
    - 程序 Bug            - 用户输入验证失败
    - 不可能状态          - 资源未找到
    - 系统级故障          - 外部 API 返回业务错误
    - 内存不足            - 文件格式不正确
    - 类型断言失败        - 权限不足（可预期的）

  规则 7.6  fetch 必须手动检查 response.ok。

    const response = await fetch(url);
    if (!response.ok) {
      throw new HttpError(
        `Request failed: ${response.status}`,
        response.status,
      );
    }

  规则 7.7  网络错误使用指数退避重试，最大重试 3 次。
            业务错误立即失败，不重试。

  规则 7.8  异常信息必须包含上下文（用户 ID、参数值等）。

    // ✗ 禁止 — 无上下文
    throw new Error('User not found');

    // ✓ 必须 — 包含上下文
    throw new NotFoundError(`User not found: id=${userId}`);


================================================================================
  8. 异步编程 — 全部硬性规则
================================================================================

  规则 8.1  独立的异步操作必须使用 Promise.all 并发。

    // ✗ 禁止 — 顺序执行浪费时间
    const user = await fetchUser(id);
    const posts = await fetchPosts(id);

    // ✓ 必须 — 并发执行
    const [user, posts] = await Promise.all([
      fetchUser(id),
      fetchPosts(id),
    ]);

  规则 8.2  Promise 组合方法选择（确定性决策）：

    需要全部成功          → Promise.all
    部分失败可接受        → Promise.allSettled
    第一个完成即可        → Promise.race
    循环中顺序 await      → for...of（禁止 forEach + async）

  规则 8.3  所有 await 调用必须包裹在 try/catch 中，
            或在调用处使用 .catch()。

  规则 8.4  所有异步操作必须设置超时。

    async function fetchWithTimeout(
      url: string,
      timeoutMs: number = 5000,
    ): Promise<Response> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }

  规则 8.5  禁止 forEach 与 async 混用。使用 for...of。

    // ✗ 禁止
    items.forEach(async (item) => {
      await processItem(item);
    });

    // ✓ 必须
    for (const item of items) {
      await processItem(item);
    }

  规则 8.6  async 函数的返回值必须被 await 或 .catch() 处理。
            禁止 fire-and-forget（发射后不管）的 async 调用。

    // ✗ 禁止 — 未处理的 Promise
    sendNotification(userId);

    // ✓ 必须
    await sendNotification(userId);
    // 或
    sendNotification(userId).catch((error: unknown) => {
      logger.error('Notification failed', { error });
    });

  规则 8.7  并发数超过 10 时必须使用并发限制器。

    import pLimit from 'p-limit';

    const limit = pLimit(5);
    const results = await Promise.all(
      items.map((item: Item) => limit(() => processItem(item))),
    );


================================================================================
  9. 项目结构 — 全部硬性规则
================================================================================

  规则 9.1  标准目录结构（必须遵循）：

    注意：此目录结构适用于分层架构（Layered Architecture）。
    若项目采用六边形架构或洋葱架构（见架构规范 §2-3），
    应使用以下目录结构替代：
      六边形：src/{core,ports,adapters}/
      洋葱：  src/{domain,application,infrastructure}/
    架构选型必须经用户确认。

    /
    ├── src/
    │   ├── index.ts              # 入口文件
    │   ├── controllers/          # 控制器（请求处理）
    │   ├── services/             # 服务层（业务逻辑）
    │   ├── repositories/         # 数据访问层
    │   ├── models/               # 数据模型/实体
    │   ├── types/                # 类型定义
    │   ├── utils/                # 工具函数
    │   ├── middleware/           # 中间件
    │   └── config/               # 配置
    ├── tests/
    │   ├── unit/                 # 单元测试
    │   ├── integration/          # 集成测试
    │   └── e2e/                  # 端到端测试
    ├── dist/                     # 编译输出（gitignore）
    ├── tsconfig.json
    ├── package.json
    └── .eslintrc.js

  规则 9.2  单个文件净行不超过 600 行（净行=排除空行与纯注释行；对齐 eslint max-lines 建议区间 100-500 的上限放宽，容忍 TS/React 组件文件）。超出应拆分；存量超限文件由 scripts/check-file-size.ts 棘轮基线管理（渐进清理）。原始行 >600 只作告警（提示注释密度/导航成本），不卡关——本项目强制写注释（check:comments），把注释计入硬门槛会惩罚文档化的代码（2026-09-06 修正）。
  规则 9.3  一个文件只包含一个核心概念/功能。
  规则 9.4  文件名使用 kebab-case：user-service.ts, http-client.ts。
  规则 9.5  测试文件与源文件同名，后缀 .test.ts。
  规则 9.6  src/ 和 tests/ 必须分离，不在 src 中写测试。
  规则 9.7  配置与代码分离。敏感配置使用环境变量。

  规则 9.8  依赖方向（单向，禁止逆向）：

    controllers → services → repositories → models
         ↓            ↓            ↓
       types        types        types

    禁止：repositories 导入 services
    禁止：models 导入 services 或 repositories
    禁止：types 导入任何非 types 模块


================================================================================
 10. ESLint 配置 — 全部规则设为 error
================================================================================

────────────────────────────────────────────────────────────────
文件：eslint.config.js（flat config 格式）
────────────────────────────────────────────────────────────────

  注意：AI 生成此文件时，所有规则必须设为 'error'，
  禁止使用 'warn' 或 'off'（除非注释明确说明降级原因）。

  import eslint from '@eslint/js';
  import tseslint from 'typescript-eslint';

  export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: import.meta.dirname,
        },
      },
      rules: {
        // === 禁止 any（零容忍）===
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',

        // === 类型一致性 ===
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/require-await': 'error',
        '@typescript-eslint/return-await': 'error',

        // === 命名 ===
        '@typescript-eslint/naming-convention': [
          'error',
          {
            selector: 'typeLike',
            format: ['PascalCase'],
          },
          {
            selector: 'variableLike',
            format: ['camelCase', 'UPPER_CASE'],
          },
          {
            selector: 'function',
            format: ['camelCase'],
          },
        ],

        // === 代码质量 ===
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/prefer-nullish-coalescing': 'error',
        '@typescript-eslint/prefer-optional-chain': 'error',
        '@typescript-eslint/no-unnecessary-condition': 'error',
        '@typescript-eslint/no-unnecessary-type-assertion': 'error',
        '@typescript-eslint/no-unnecessary-type-arguments': 'error',
        '@typescript-eslint/prefer-readonly': 'error',
        '@typescript-eslint/prefer-readonly-parameter-types': 'error',
        '@typescript-eslint/prefer-infer': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/no-confusing-non-null-assertion': 'error',

        // === 模块 ===
        'import/no-cycle': 'error',
        'import/no-default-export': 'error',
        'import/order': [
          'error',
          {
            groups: [
              'builtin',
              'external',
              'internal',
              'parent',
              'sibling',
              'index',
            ],
            'newlines-between': 'always',
            alphabetize: { order: 'asc' },
          },
        ],
      },
    },
  );

────────────────────────────────────────────────────────────────
关键规则说明（AI 必须理解）：
────────────────────────────────────────────────────────────────

  no-explicit-any: 'error'
    → 代码中出现 any 即报错。AI 必须使用 unknown 替代。

  no-unsafe-*: 'error'（5 条）
    → 禁止将 any 值赋给安全变量、访问 any 成员、调用 any 函数、
      传 any 参数、返回 any 值。AI 在处理 unknown 时必须先缩小类型。

  no-floating-promises: 'error'
    → 所有 Promise 必须被 await、return 或 .catch() 处理。
      AI 禁止写出 fire-and-forget 的异步调用。

  no-misused-promises: 'error'
    → 禁止将 async 函数传给不期望 Promise 的参数（如事件回调）。

  no-non-null-assertion: 'error'
    → 禁止使用 ! 非空断言（如 user!.name）。
      AI 必须使用 if (user !== null) 显式检查。

  switch-exhaustiveness-check: 'error'
    → switch 语句必须穷尽所有联合类型成员。

  import/no-default-export: 'error'
    → 禁止默认导出，强制命名导出。

  prefer-readonly-parameter-types: 'error'
    → 函数参数应标记为 readonly（对于数组和对象）。


================================================================================
 11. Prettier 配置 — 精确配置
================================================================================

────────────────────────────────────────────────────────────────
文件：.prettierrc
────────────────────────────────────────────────────────────────

  {
    "printWidth": 100,
    "tabWidth": 2,
    "useTabs": false,
    "semi": true,
    "singleQuote": true,
    "jsxSingleQuote": false,
    "trailingComma": "all",
    "bracketSpacing": true,
    "bracketSameLine": false,
    "arrowParens": "always",
    "endOfLine": "lf"
  }

  AI 生成的所有代码必须符合此 Prettier 配置，无需运行 Prettier 验证。


================================================================================
 12. 测试规范 — 全部硬性规则
================================================================================

  规则 12.1  测试文件命名：{source-name}.test.ts，与源文件同目录。

  规则 12.2  测试描述必须描述行为，不描述实现。

    // ✗ 禁止
    describe('setError', () => { ... });

    // ✓ 必须
    describe('when input is invalid', () => { ... });

  规则 12.3  每个 test 必须遵循 Arrange-Act-Assert 模式。

    test('returns user when id exists', () => {
      // Arrange
      const userId = '123';
      mockDb.find.mockReturnValue({ id: '123', name: 'Alice' });

      // Act
      const result = getUserById(userId);

      // Assert
      expect(result).toEqual({ id: '123', name: 'Alice' });
    });

  规则 12.4  每个 beforeEach 必须调用 vi.clearAllMocks()。

  规则 12.5  禁止在测试中访问私有成员。测试公共 API 行为。
  规则 12.6  外部依赖必须通过依赖注入替换为 Mock。
  规则 12.7  测试之间不能有依赖关系，可独立运行。
  规则 12.8  每个函数的测试覆盖率必须达到：
              - 语句覆盖率 ≥ 90%
              - 分支覆盖率 ≥ 85%
              - 函数覆盖率 ≥ 90%
              - 行覆盖率 ≥ 90%


================================================================================
 13. 安全规范 — 全部硬性规则
================================================================================

  规则 13.1  所有外部输入必须通过 Zod 验证。

    import { z } from 'zod';

    const createUserSchema = z.object({
      email: z.string().email(),
      password: z.string().min(8).max(128),
      name: z.string().min(1).max(100),
      age: z.number().int().min(0).max(150),
    });

    type CreateUserInput = z.infer<typeof createUserSchema>;

    function handleCreateUser(rawInput: unknown): User {
      const result = createUserSchema.safeParse(rawInput);
      if (!result.success) {
        throw new ValidationError(
          result.error.issues.map((i) => i.message).join('; '),
        );
      }
      // result.data 的类型是 CreateUserInput，安全使用
      return createUserService(result.data);
    }

  规则 13.2  禁止使用 eval()、new Function()、setTimeout(string)。
  规则 13.3  禁止将用户输入拼接到系统命令中。
  规则 13.4  禁止将用户输入直接赋值给 innerHTML。
  规则 13.5  使用 Object.create(null) 创建无原型对象用于键值存储。
  规则 13.6  禁止硬编码密钥、密码、token。使用环境变量。
  规则 13.7  日志中禁止记录密码、密钥、个人隐私信息。
  规则 13.8  SQL 必须使用参数化查询，禁止字符串拼接 SQL。

    // ✗ 禁止 — SQL 注入风险
    const query = `SELECT * FROM users WHERE id = '${userId}'`;

    // ✓ 必须 — 参数化查询
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await pool.query(query, [userId]);

  规则 13.9  文件路径必须规范化，防止路径遍历攻击。

    import path from 'node:path';

    function safeJoin(base: string, target: string): string {
      const targetPath = path.posix.normalize(target);
      if (targetPath.startsWith('..') || path.isAbsolute(targetPath)) {
        throw new Error('Path traversal detected');
      }
      return path.join(base, targetPath);
    }

  规则 13.10 密码使用 bcrypt 哈希，禁止明文存储。
  规则 13.11 token 随机生成，长度不少于 32 字节。
  规则 13.12 传输使用 TLS 1.2 以上。


================================================================================
 14. 性能规范 — 全部硬性规则
================================================================================

  规则 14.1  仅类型导入必须使用 import type。

  规则 14.2  package.json 必须设置 "sideEffects": false（库项目）。

  规则 14.3  使用具名导出，不用默认导出（支持 Tree Shaking）。

  规则 14.4  大数据集使用流式处理，禁止一次性加载到内存。

    // ✗ 禁止 — 大文件全量读取
    const data = await readFile('large.json', 'utf-8');
    const records = JSON.parse(data);

    // ✓ 必须 — 流式处理
    const stream = createReadStream('large.json');
    for await (const chunk of stream) {
      processChunk(chunk);
    }

  规则 14.5  避免在循环中创建大对象，使用对象池复用。
  规则 14.6  缓存必须设置过期时间（TTL）。
  规则 14.7  避免在热路径中创建闭包。
  规则 14.8  批量操作优先于循环单条操作（如批量插入）。


================================================================================
 15. API 设计 — 全部硬性规则
================================================================================

  规则 15.1  RESTful URL 使用名词复数，版本号在 URL 中。

    GET    /api/v1/users          # 列表
    GET    /api/v1/users/:id      # 详情
    POST   /api/v1/users          # 创建
    PUT    /api/v1/users/:id      # 全量更新
    PATCH  /api/v1/users/:id      # 部分更新
    DELETE /api/v1/users/:id      # 删除

  规则 15.2  统一响应格式（所有接口必须遵循）：

    // 成功响应
    interface ApiResponse<T> {
      code: number;        // 业务状态码，0 表示成功
      message: string;     // 人类可读消息
      data: T;             // 响应数据
      timestamp: string;   // ISO 8601 时间戳
    }

    // 错误响应
    interface ApiErrorResponse {
      code: number;        // 业务错误码
      message: string;     // 错误消息
      details?: unknown;   // 错误详情（验证错误字段列表等）
      timestamp: string;   // ISO 8601 时间戳
    }

    // 分页响应
    interface PaginatedApiResponse<T> extends ApiResponse<T[]> {
      pagination: {
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };
    }

  规则 15.3  HTTP 状态码使用（必须精确）：

    200 → 成功读取/更新（返回 body）
    201 → 创建成功（返回 body + Location 头）
    204 → 成功删除（无 body）
    400 → 请求参数无效
    401 → 未认证
    403 → 无权限
    404 → 资源不存在
    409 → 资源冲突
    422 → 语义验证失败
    500 → 服务器内部错误
    502 → 外部服务错误
    503 → 服务不可用

  规则 15.4  分页参数：page（从 1 开始），pageSize（默认 20，最大 100）。
  规则 15.5  所有 API 输入必须通过 Zod 验证。
  规则 15.6  所有 API 响应必须有 TypeScript 类型定义。


================================================================================
 16. 代码组织与架构 — 全部硬性规则
================================================================================

  规则 16.1  遵循 SOLID 原则（每一条都必须遵守）：

    S — 单一职责：一个类/模块只负责一个功能域
    O — 开闭原则：通过 interface 扩展，不修改已有代码
    L — 里氏替换：子类必须能替换父类不破坏正确性
    I — 接口隔离：多个专用接口优于一个胖接口
    D — 依赖倒置：依赖 interface 不依赖具体实现

  规则 16.2  依赖注入：外部依赖通过构造函数参数注入。

    // ✓ 必须 — 依赖通过接口注入
    interface UserRepository {
      findById(id: string): Promise<User | null>;
      save(user: User): Promise<void>;
    }

    class UserService {
      constructor(private readonly userRepo: UserRepository) {}

      async getUser(id: string): Promise<User | null> {
        return this.userRepo.findById(id);
      }
    }

    // 测试时注入 Mock
    const mockRepo: UserRepository = {
      findById: vi.fn(),
      save: vi.fn(),
    };
    const service = new UserService(mockRepo);

  规则 16.3  业务逻辑不依赖基础设施。
            services 层不直接调用 fs、http、db 驱动。
            通过 repository 接口抽象数据访问。

  规则 16.4  禁止容器类（只有静态方法的类）。使用独立函数。

  规则 16.5  禁止在业务逻辑中直接调用 console.log。
            使用注入的 logger 接口。

    interface ILogger {
      debug(message: string, context?: Record<string, unknown>): void;
      info(message: string, context?: Record<string, unknown>): void;
      warn(message: string, context?: Record<string, unknown>): void;
      error(message: string, context?: Record<string, unknown>): void;
    }


================================================================================
 17. 日志规范 — 全部硬性规则
================================================================================

  规则 17.1  日志级别使用规则：

    DEBUG  → 开发环境使用，生产环境关闭
    INFO   → 关键业务节点：函数入口/出口、外部调用请求/响应
    WARN   → 可预期的异常情况（如重试、降级）
    ERROR  → 异常和错误，必须包含完整堆栈
    FATAL  → 系统不可恢复的严重错误

  规则 17.2  每条日志必须包含：
    - 时间戳（ISO 8601）
    - 日志级别
    - 模块名
    - 消息
    - 上下文（对象格式，如 { userId, action, duration }）

  规则 17.3  ERROR 日志必须包含完整异常堆栈。
  规则 17.4  禁止在高频循环中写日志（性能问题）。
  规则 17.5  禁止记录：密码、密钥、token、个人隐私信息。
  规则 17.6  日志使用结构化格式（JSON），禁止字符串拼接。

    // ✗ 禁止
    logger.info('User ' + userId + ' logged in from ' + ip);

    // ✓ 必须
    logger.info('User logged in', { userId, ip, timestamp: new Date().toISOString() });


================================================================================
 18. 文档标准 — 全部硬性规则
================================================================================

  规则 18.1  所有 export 的函数、类、接口、类型必须有 TSDoc 注释。

  规则 18.2  TSDoc 必须包含以下标签（按顺序）：

    /**
     * 简要描述函数功能（一行）。
     *
     * @param paramName - 参数描述（每个参数一行）
     * @returns 返回值描述
     * @throws ThrowErrorType - 可能抛出的异常及条件
     * @example
     * ```ts
     * const result = functionName(arg);
     * ```
     */

  规则 18.3  注释解释"为什么"，不解释"做了什么"。
  规则 18.4  禁止注释掉的大段代码（删除它）。
  规则 18.5  禁止显而易见的注释（如 // 加 1）。
  规则 18.6  TODO 注释必须包含原因、计划和预期日期：
            // TODO: 优化性能，当前 O(n²) 实现，
            // 计划用哈希表重构，2025-06-01

  规则 18.7  使用 @internal 标记内部 API。
  规则 18.8  使用 @deprecated 标记废弃 API，并提供替代方案。


================================================================================
 19. Monorepo 配置 — 全部硬性规则
================================================================================

  规则 19.1  Monorepo 标准目录结构：

    /
    ├── package.json              # private: true
    ├── pnpm-workspace.yaml
    ├── turbo.json
    ├── apps/
    │   ├── web/                  # 应用
    │   └── api/
    └── packages/
        ├── ui/                   # 共享 UI 库
        ├── typescript-config/    # 共享 tsconfig
        ├── eslint-config/        # 共享 ESLint 配置
        └── prettier-config/      # 共享 Prettier 配置

  规则 19.2  根 package.json 必须设为 "private": true。
  规则 19.3  禁止跨包直接文件引用（../）。必须作为依赖安装后 import。
  规则 19.4  共享配置必须提取到 packages/ 中的独立包。
  规则 19.5  每个包必须有独立的 tsconfig.json，extends 共享配置。
  规则 19.6  不支持嵌套包（apps/web/mobile 不行，用 apps/web-mobile）。

  规则 19.7  共享 tsconfig 包结构：

    packages/typescript-config/
    ├── package.json
    ├── base.json       # 基础配置（所有项目 extends 此文件）
    ├── react.json      # React 项目配置
    └── node.json       # Node.js 项目配置

    // base.json 内容就是第 1 节的完整 tsconfig
    // react.json 在 base 上添加 jsx 配置
    // node.json 在 base 上调整 module 为 nodenext


================================================================================
 20. package.json 脚本 — 必须包含以下脚本
================================================================================

  {
    "scripts": {
      "dev": "vite",
      "build": "tsc --noEmit && vite build",
      "typecheck": "tsc --noEmit",
      "typecheck:watch": "tsc --noEmit --watch",
      "lint": "eslint . --max-warnings 0",
      "lint:fix": "eslint . --fix",
      "format": "prettier --write .",
      "format:check": "prettier --check .",
      "test": "vitest",
      "test:coverage": "vitest --coverage",
      "test:watch": "vitest --watch",
      "check:circular": "madge --circular --extensions ts,tsx src/",
      "precommit": "lint-staged",
      "prepare": "husky"
    }
  }

  注意：lint 脚本必须包含 --max-warnings 0，
  意味着零警告容忍 — 任何 warning 都会导致 CI 失败。


================================================================================
 21. Git Hooks — 全部硬性规则
================================================================================

  规则 21.1  pre-commit 钩子必须运行 lint-staged。

    // .husky/pre-commit
    npx lint-staged

  规则 21.2  commit-msg 钩子必须运行 commitlint。

    // .husky/commit-msg
    npx commitlint --edit $1

  规则 21.3  commitlint 配置使用 Conventional Commits。

    // commitlint.config.js
    export default {
      extends: ['@commitlint/config-conventional'],
      rules: {
        'type-enum': [
          2,
          'always',
          [
            'feat',     // 新功能
            'fix',      // Bug 修复
            'docs',     // 文档变更
            'style',    // 代码格式（不影响功能）
            'refactor', // 重构（既不是 feat 也不是 fix）
            'perf',     // 性能优化
            'test',     // 测试相关
            'build',    // 构建系统或外部依赖变更
            'ci',       // CI 配置变更
            'chore',    // 其他杂项
            'revert',   // 回滚 commit
          ],
        ],
        'subject-max-length': [2, 'always', 72],
      },
    };

  规则 21.4  commit 消息格式（必须遵循）：

    type(scope): subject

    body（可选，解释为什么）

    footer（可选，如 BREAKING CHANGE）

  规则 21.5  lint-staged 配置：

    // package.json 中的 lint-staged 字段
    {
      "lint-staged": {
        "*.{ts,tsx}": [
          "eslint --fix --max-warnings 0",
          "prettier --write"
        ],
        "*.{json,md,yml,yaml}": [
          "prettier --write"
        ]
      }
    }


================================================================================
 22. AI 代码生成检查清单
================================================================================

  AI 在生成或修改 TypeScript 代码后，必须逐项检查以下清单。
  任何一项不通过，代码即为有缺陷，必须修正后才能交付。

  【类型安全】
  □ 没有使用 any（包括隐式 any）
  □ 没有使用 @ts-ignore 或 eslint-disable
  □ 没有使用 ! 非空断言（使用显式 null 检查）
  □ 所有函数参数有显式类型标注
  □ 所有 export 函数有显式返回类型
  □ 仅类型导入使用 import type
  □ catch 变量按 unknown 处理
  □ switch 语句有穷尽性检查（never）
  □ 数组索引访问后进行了 undefined 检查

  【错误处理】
  □ 没有空 catch 块
  □ catch 中进行了类型缩小（instanceof 检查）
  □ 可预期失败使用 Result 类型而非异常
  □ 异常信息包含上下文
  □ fetch 调用检查了 response.ok

  【异步编程】
  □ 独立异步操作使用 Promise.all
  □ 没有使用 forEach + async
  □ 所有 Promise 被 await 或 .catch() 处理
  □ 异步操作设置了超时
  □ 没有未处理的 Promise rejection

  【安全】
  □ 外部输入通过 Zod 验证
  □ 没有 eval / new Function
  □ 没有字符串拼接 SQL
  □ 没有硬编码密钥
  □ 没有将用户输入赋值给 innerHTML
  □ 日志中没有敏感信息

  【命名】
  □ 类型/接口/类使用 PascalCase
  □ 变量/函数使用 camelCase
  □ 常量使用 CONSTANT_CASE
  □ 文件名使用 kebab-case
  □ 接口没有 I 前缀
  □ 没有缩写名称
  □ 布尔变量有 is/has/can/should 前缀

  【模块】
  □ 使用命名导出，没有默认导出
  □ 没有循环依赖
  □ 导入按标准库→第三方→本地排序
  □ 没有使用 namespace
  □ 没有使用 barrel files

  【架构】
  □ 外部依赖通过构造函数注入
  □ 业务逻辑不直接依赖基础设施
  □ 依赖方向单向无循环
  - 文件净行数不超过 600 行（工具：pnpm check:file-size，豁免清单渐进清理）
  - 函数体不超过 100 净行（工具：pnpm check:functions，51–100 仅提示不卡关；棘轮只锁 >100）
  - 函数认知复杂度不超过 15（工具：pnpm check:complexity，复用 Biome 内置规则；棘轮按文件锁定）
  - 函数参数不超过 4 个，超出对象封装（工具：pnpm check:functions，error 卡关；DI 装配函数豁免）

  【测试】
  □ 测试描述行为而非实现
  □ 每个 test 遵循 Arrange-Act-Assert
  □ beforeEach 调用了 clearAllMocks
  □ 外部依赖被 Mock 替换

  【文档】
  □ 所有 export 有 TSDoc 注释
  □ 注释解释"为什么"而非"做了什么"
  □ 没有注释掉的代码
  □ TODO 注释包含原因和日期


================================================================================
 23. 常见错误模式速查（AI 禁止生成以下代码）
================================================================================

  以下代码模式被完全禁止。如果 AI 生成了以下任何模式，必须立即修正。

  ┌────────────────────────────────────────────────────────────────┐
  │ 禁止模式                              │ 正确做法               │
  ├───────────────────────────────────────┼────────────────────────┤
  │ : any                                 │ : unknown + 类型缩小    │
  │ export default                        │ export { namedExport } │
  │ var x = 1                             │ const x = 1            │
  │ new Array()                           │ []                     │
  │ new Object()                          │ {}                     │
  │ forEach(async ...)                    │ for...of + await       │
  │ eval() / new Function()               │ 不使用动态代码执行       │
  │ @ts-ignore                            │ 修复类型错误            │
  │ ! 非空断言 (user!.name)               │ if (user) { ... }      │
  │ catch { } 空 catch                     │ catch (e) { log(e) }  │
  │ as any / as unknown as T              │ 类型守卫函数            │
  │ Array<T>                              │ T[]                    │
  │ String / Number / Boolean             │ string / number / bool │
  │ import { User } (仅类型)              │ import type { User }   │
  │ namespace Foo                         │ module (export/import) │
  │ export let x                          │ export function getX() │
  │ String 拼接 SQL                       │ 参数化查询              │
  │ String 拼接 innerHTML                 │ textContent / sanitize │
  │ Date.now() 在纯函数中                  │ now 作为参数传入        │
  │ console.log 在业务代码中               │ 注入的 logger           │
  │ if (x) doSomething()                  │ if (x) { doSomething()}│
  │ 'str' + var                           │ `str ${var}`           │
  └───────────────────────────────────────┴────────────────────────┘


================================================================================
  文档结束
================================================================================

  本规范为 AI 编码代理的硬性约束文档。
  AI 在生成 TypeScript 代码时必须逐条遵守，无例外、无变通、无省略。
  当遇到本规范未覆盖的场景时，选择最严格的做法并标注 [NEEDS CLARIFICATION]
  向用户确认。
