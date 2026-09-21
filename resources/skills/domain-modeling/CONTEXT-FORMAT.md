# CONTEXT.md 格式

## 结构

```md
# {上下文名称}

{一到两句：这个上下文是什么、为什么存在。}

## Language

**Order**：
{一到两句描述这个术语}
_避免_：Purchase、transaction

**Invoice**：
发货之后向客户发出的付款请求。
_避免_：Bill、payment request

**Customer**：
下单的人或组织。
_避免_：Client、buyer、account
```

## 规则

- **要有主见。** 同一个概念有多个词时，**选最好的那个**，其余列进 `_避免_`。
  一个术语表如果对同义词不表态，它就只是一份词汇收集，起不到规范用词的作用；
- **定义要收紧。** 最多一到两句。定义它**是什么**，不是它**做什么**
  （「做什么」是实现细节，会过期）；
- **只收这个项目的上下文特有的术语。** 通用的编程概念（超时、错误类型、工具函数模式）
  不属于这里，哪怕这个项目里到处都在用它们。加一个词之前先问自己：
  **这是这个上下文独有的概念，还是一个通用编程概念？** 只有前者该进来；
- **自然地分组。** 出现明显的簇时用小标题归类；如果所有术语都属于同一个内聚的领域，
  平铺一张列表就行。

## 单上下文 vs 多上下文仓库

**单上下文（多数仓库）：** 仓库根目录一份 `CONTEXT.md`。

**多上下文：** 仓库根目录放一份 `CONTEXT-MAP.md`，列出有哪些上下文、各自住在哪、
以及它们之间的关系：

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md)：接收并跟踪客户订单
- [Billing](./src/billing/CONTEXT.md)：生成发票并处理付款
- [Fulfillment](./src/fulfillment/CONTEXT.md)：管理仓库拣货与发货

## Relationships

- **Ordering → Fulfillment**：Ordering 发出 `OrderPlaced` 事件；Fulfillment 消费它开始拣货
- **Fulfillment → Billing**：Fulfillment 发出 `ShipmentDispatched` 事件；Billing 消费它来生成发票
- **Ordering ↔ Billing**：共享 `CustomerId` 与 `Money` 类型
```

这个技能自己推断该用哪种结构：

- 有 `CONTEXT-MAP.md` → 读它找到各个上下文；
- 只有根目录一份 `CONTEXT.md` → 单上下文；
- 两个都没有 → 第一个术语定下来时，按需创建根目录的 `CONTEXT.md`。

有多个上下文时，**自己推断当前话题属于哪一个**。真的推断不出来才问用户。
