---
name: coding-assistant
description: 编程辅助全流程：代码生成、调试、重构、最佳实践。覆盖主流语言和框架，帮程序员提高开发效率。
license: MIT
metadata:
  author: PolarAgent Team
  version: "1.0.0"
  category: 开发
---

# 编程辅助

这项技能指导你编写「可运行、可维护、符合最佳实践」的代码。核心不是「能跑就行」，而是「跑得对、改得动、看得懂」。

## 何时使用

- 需要编写新功能或模块
- 需要调试和修复 Bug
- 需要重构现有代码
- 需要代码审查和优化建议
- 需要学习新的语言或框架

## 编程原则

### 代码质量六大原则

**1. 可读性优先（Readability）**
- 变量命名清晰（`getUserById` 优于 `get`）
- 适当注释（解释为什么，不是解释做什么）
- 合理缩进和空行（视觉分组）
- 一致的代码风格

**2. 单一职责（Single Responsibility）**
- 一个函数只做一件事
- 一个类只有一个变化的理由
- 功能内聚，减少耦合

**3. DRY 原则（Don't Repeat Yourself）**
- 避免重复代码
- 提取公共逻辑为函数
- 使用配置而非硬编码

**4. KISS 原则（Keep It Simple, Stupid）**
- 简单解决问题，不过度设计
- 避免炫技式编程
- 优先选择简单方案

**5. YAGNI 原则（You Aren't Gonna Need It）**
- 不写用不到的代码
- 不提前优化
- 需要时再扩展

**6. 防御性编程（Defensive Programming）**
- 验证输入参数
- 处理边界条件
- 优雅处理异常
- 提供清晰的错误信息

## 语言与框架覆盖

### 前端

**JavaScript / TypeScript**
```typescript
// 良好实践：类型安全 + 清晰命名
interface User {
  id: string;
  name: string;
  email: string;
}

async function getUserById(userId: string): Promise<User | null> {
  try {
    const response = await fetch(`/api/users/${userId}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch user:', error);
    return null;
  }
}
```

**React**
```tsx
// 良好实践：职责分离 + Hooks
interface UserCardProps {
  userId: string;
}

function UserCard({ userId }: UserCardProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    
    async function fetchUser() {
      try {
        const data = await getUserById(userId);
        if (!cancelled) {
          setUser(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError('加载失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchUser();
    
    return () => { cancelled = true; }; // 清理函数
  }, [userId]);

  if (loading) return <div>加载中...</div>;
  if (error) return <div>错误: {error}</div>;
  if (!user) return <div>用户不存在</div>;

  return (
    <div className="user-card">
      <h3>{user.name}</h3>
      <p>{user.email}</p>
    </div>
  );
}
```

**Vue**
```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface User {
  id: string;
  name: string;
  email: string;
}

const props = defineProps<{ userId: string }>();

const user = ref<User | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const data = await getUserById(props.userId);
    user.value = data;
  } catch (err) {
    error.value = '加载失败';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div v-if="loading">加载中...</div>
  <div v-else-if="error">错误: {{ error }}</div>
  <div v-else-if="user" class="user-card">
    <h3>{{ user.name }}</h3>
    <p>{{ user.email }}</p>
  </div>
  <div v-else>用户不存在</div>
</template>
```

### 后端

**Python**
```python
from typing import Optional
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)

@dataclass
class User:
    """用户数据类"""
    id: str
    name: str
    email: str

class UserService:
    """用户服务类"""
    
    def __init__(self, db_connection):
        self.db = db_connection
    
    def get_user_by_id(self, user_id: str) -> Optional[User]:
        """
        根据ID获取用户
        
        Args:
            user_id: 用户ID
            
        Returns:
            User对象，如果不存在则返回None
            
        Raises:
            DatabaseError: 数据库查询失败
        """
        try:
            result = self.db.query(
                "SELECT id, name, email FROM users WHERE id = %s",
                (user_id,)
            )
            if result:
                return User(**result)
            return None
        except Exception as e:
            logger.error(f"Failed to fetch user {user_id}: {e}")
            raise
```

**Node.js / Express**
```typescript
import express, { Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';

const app = express();

// 中间件：错误处理
function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error(err.stack);
  res.status(500).json({
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}

// 路由：获取用户
app.get('/api/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const user = await getUserById(id);
    
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    res.json(user);
  } catch (error) {
    next(error);
  }
});

// 路由：创建用户
app.post('/api/users',
  body('name').notEmpty().trim(),
  body('email').isEmail().normalizeEmail(),
  async (req: Request, res: Response, next: NextFunction) => {
    // 验证输入
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const user = await createUser(req.body);
      res.status(201).json(user);
    } catch (error) {
      next(error);
    }
  }
);

app.use(errorHandler);
```

## 常见场景与模式

### 1. 错误处理

**JavaScript/TypeScript**
```typescript
// ❌ 不好：吞掉错误
try {
  await riskyOperation();
} catch (e) {
  // 什么都不做
}

// ✅ 好：记录并处理
try {
  await riskyOperation();
} catch (error) {
  logger.error('Operation failed:', error);
  throw new AppError('操作失败', { cause: error });
}

// ✅ 好：返回 Result 类型
type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

async function riskyOperation(): Promise<Result<Data>> {
  try {
    const data = await fetchData();
    return { ok: true, value: data };
  } catch (error) {
    return { ok: false, error };
  }
}
```

**Python**
```python
# ❌ 不好：过于宽泛的异常
try:
    do_something()
except Exception:
    pass

# ✅ 好：具体的异常类型
try:
    user = get_user(user_id)
except UserNotFoundError as e:
    logger.warning(f"User {user_id} not found")
    return None
except DatabaseError as e:
    logger.error(f"Database error: {e}")
    raise
```

### 2. 异步处理

**并发控制**
```typescript
// ❌ 不好：串行执行（慢）
const user = await getUser(userId);
const posts = await getPosts(userId);
const comments = await getComments(userId);

// ✅ 好：并行执行
const [user, posts, comments] = await Promise.all([
  getUser(userId),
  getPosts(userId),
  getComments(userId)
]);

// ✅ 更好：带超时和错误处理
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), ms)
  );
  return Promise.race([promise, timeout]);
}

const results = await Promise.allSettled([
  withTimeout(getUser(userId), 5000),
  withTimeout(getPosts(userId), 5000),
  withTimeout(getComments(userId), 5000)
]);
```

### 3. 数据验证

**输入验证**
```typescript
// Zod 验证库示例
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.number().int().min(0).max(150).optional(),
  role: z.enum(['user', 'admin'])
});

function createUser(input: unknown) {
  // 验证 + 类型推断
  const validatedData = UserSchema.parse(input);
  // validatedData 的类型是 { name: string; email: string; ... }
  
  return saveUser(validatedData);
}

// 安全版本：返回验证结果
function validateUser(input: unknown) {
  const result = UserSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, errors: result.error.errors };
  }
  return { ok: true, data: result.data };
}
```

### 4. 性能优化

**Memoization（缓存）**
```typescript
// React useMemo
const expensiveValue = useMemo(() => {
  return computeExpensiveValue(a, b);
}, [a, b]); // 仅当 a 或 b 变化时重新计算

// 通用 memoize 函数
function memoize<T extends (...args: any[]) => any>(fn: T): T {
  const cache = new Map();
  
  return ((...args: Parameters<T>) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }) as T;
}

const fibonacci = memoize((n: number): number => {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
});
```

**批量处理**
```typescript
// ❌ 不好：逐个查询（N+1 问题）
const posts = await getPosts();
for (const post of posts) {
  post.author = await getUser(post.authorId); // 每篇文章一次查询
}

// ✅ 好：批量查询
const posts = await getPosts();
const authorIds = [...new Set(posts.map(p => p.authorId))];
const authors = await getUsersByIds(authorIds);
const authorMap = new Map(authors.map(a => [a.id, a]));

for (const post of posts) {
  post.author = authorMap.get(post.authorId);
}
```

## 调试技巧

### 1. 日志记录

```typescript
// 结构化日志
logger.info('User login', {
  userId: user.id,
  ip: req.ip,
  userAgent: req.headers['user-agent'],
  timestamp: new Date().toISOString()
});

// 不同级别
logger.debug('详细调试信息'); // 开发时
logger.info('正常流程信息');  // 关键操作
logger.warn('潜在问题警告');  // 需要注意
logger.error('错误信息', { error }); // 需要处理
```

### 2. 断点调试

```typescript
// 条件断点（仅在特定条件下暂停）
if (userId === 'problematic-user-id') {
  debugger; // 仅对这个用户触发断点
}
```

### 3. 性能分析

```typescript
// 测量执行时间
console.time('operation');
await expensiveOperation();
console.timeEnd('operation'); // operation: 1234.56ms

// React Profiler
import { Profiler } from 'react';

<Profiler id="MyComponent" onRender={(id, phase, actualDuration) => {
  console.log(`${id} (${phase}) took ${actualDuration}ms`);
}}>
  <MyComponent />
</Profiler>
```

## 代码审查清单

**功能正确性：**
- [ ] 是否实现了所有需求？
- [ ] 边界条件是否处理？（空值、零、负数、极大值）
- [ ] 错误场景是否处理？

**代码质量：**
- [ ] 变量命名是否清晰？
- [ ] 函数是否单一职责？
- [ ] 是否有重复代码？
- [ ] 注释是否解释了「为什么」？

**性能考虑：**
- [ ] 有没有不必要的循环？
- [ ] 有没有 N+1 查询？
- [ ] 大数据量是否会有性能问题？

**安全检查：**
- [ ] 用户输入是否验证？
- [ ] 是否有 SQL 注入风险？
- [ ] 敏感信息是否暴露？（密码、token）
- [ ] 权限检查是否完整？

**测试覆盖：**
- [ ] 核心逻辑是否有单元测试？
- [ ] 边界条件是否有测试？
- [ ] 错误场景是否有测试？

## 输出要求

- 代码必须包含中文注释（解释关键逻辑）
- 使用 `write_file` 或 `edit_file` 实际操作文件
- 提供完整的代码（不要用省略号）
- 说明如何运行和测试代码
- 必要时生成 README 或技术文档

## 参考资料

- Clean Code（Robert C. Martin）
- Refactoring（Martin Fowler）
- You Don't Know JS（Kyle Simpson）
- Effective TypeScript（Dan Vanderkam）
