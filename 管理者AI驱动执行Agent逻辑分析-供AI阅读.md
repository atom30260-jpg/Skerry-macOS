# AgentsGZT 管理者 AI 驱动执行 Agent：最新逻辑分析与交接文档

**文档用途**：供其他 AI 读取项目背景、理解当前实现、识别已验证能力和未完成闭环，并据此继续分析或修改。  
**项目目录**：`C:\Users\Administrator\Desktop\CCL\AgentsGZT`  
**分析日期**：2026-09-18  
**文档状态**：已根据 2026-09-18 20:50 前后重新读取的最新源码、测试结果和静态检查结果更新。  
**本次更新范围**：只更新本文档，没有修改源码。

---

## 0. 阅读规则

1. 本文基于 2026-09-18 当前工作区源码，后续修改前必须重新读取源码和测试。
2. 文中使用以下标记：
   - `[已验证事实]`：由当前源码、测试或命令结果直接确认。
   - `[代码存在，未完成真实链路验证]`：源码中存在，但尚未通过真实供应商、真实浏览器或完整端到端流程确认。
   - `[风险]`：根据当前代码路径推断出的并发、状态或产品风险。
   - `[建议]`：后续设计建议，不代表当前已经实现。
   - `[待决策]`：需要产品负责人确定的行为。
3. `npm test`通过只能证明本地测试契约和模拟流程通过，不能代表真实模型、真实并发、真实浏览器行为已经确认。`npm run check`通过只能证明列出的 JavaScript 文件语法检查通过。
4. 不要把管理者 clone 当成 execution Agent，也不要在没有明确需求时恢复旧的多 Agent 体系。

---

## 1. 最新结论

### 1.1 管理者驱动 execution Agent 的主链路已经成立

当前已经实现：

```text
用户向管理者 AI 提出任务
    ↓
管理者获得 workbench 管理工具
    ↓
管理者调用 workbench_dispatch
    ↓
系统根据连接、系列、模型或 prompt 选择目标
    ↓
复用空闲 execution，或创建新的 execution 分区
    ↓
创建 taskId 并写入 running 任务卡片
    ↓
后台启动 execution Agent 的 runTurn
    ↓
execution Agent 使用自己的模型和工具执行任务
    ↓
更新任务卡片、execution transcript、manager transcript 摘要和前端事件
```

**[已验证事实]**：管理者 AI确实能够选择、创建和启动 execution Agent，不只是生成前端任务卡片。

### 1.2 完整的结果协调闭环仍未形成

当前 execution 完成后，普通 execution 和 clone 的结果处理已经分流：

```text
普通 execution：
  更新群聊任务卡片
  保存 execution transcript
  将截断后的摘要追加到 manager transcript，kind: dispatch_result
  发送 dispatch_result、group_event 等前端事件

clone：
  更新群聊任务卡片
  将摘要追加到 manager transcript，kind: clone_result
  发送 clone_result 事件
```

**[已验证事实]**：普通 execution 的摘要已经会回写管理者 transcript；前端也有 `dispatch_result` 的接收和展示路径。结果到达后不会自动开启管理者的新模型回合。

当前仍缺少稳定的：

```text
结构化 execution 结果（文件、工具、错误、耗时等）
    ↓
后台完成后自动开启新的管理者回合
    ↓
管理者继续判断、重试、派发下一步、汇总或请求用户确认
```

### 1.3 本轮复核新增确认

**[已验证事实]**：本轮重新执行 `npm test` 得到 186 个测试通过，重新执行 `npm run check` 通过。最新增加的 3 个界面与事件测试进一步确认：

1. `scrollChatToLatest` 会同时把对话日志和群聊日志定位到最新内容；
2. `clone_result` 在 Agent 详情页不会写入普通 execution 会话，只进入管理者视图；
3. `dispatch_result` 会写入管理者视图，普通 execution 的结果会通过群聊 worker 事件展示。

这三项确认的是**前端视图路由、展示和滚动行为**。它们没有证明后台 execution 完成后会自动再次调用管理者模型，也没有证明真实供应商、真实浏览器断线重连或并发写入已经安全。

**[已验证事实]**：`overlaySystem()` 明确要求管理者在调用派发工具后告知用户已派发，并说明 execution 结果会稍后出现在群聊和管理者 transcript 中；结果不会作为新的 tool result 自动返回管理者。因此“事件已经展示”和“管理者已经消费结果并继续规划”必须继续分开判断。

因此当前产品能力应定义为：

> 管理者 AI 可以异步派发 execution Agent；execution 完成摘要会持久化到管理者 transcript 和群聊，但管理者不会因此自动开启下一回合。

当前尚未完成：

> 管理者 AI 在后台结果到达后，自动持续协调多阶段任务，并基于结构化结果稳定地重试、串联和汇总。

---

## 2. 当前角色模型

### 2.1 管理者 AI

管理者 AI负责：

1. 接收用户原始目标；
2. 判断是否可以直接回答；
3. 判断是否需要其他 AI执行；
4. 识别用户指定的产品系列或连接；
5. 选择已有 execution 或创建新的 execution 分区；
6. 创建任务并返回异步状态；
7. 后续应接收 execution 结果并决定下一步；
8. 向用户汇总最终结果。

管理者当前不应直接承担：

- 文件编辑；
- 终端命令执行；
- execution Agent的全部工作；
- 伪装成其他产品的执行工具。

### 2.2 Execution Agent

Execution Agent负责真正执行用户工作：

- 读取项目文件；
- 修改文件；
- 执行命令；
- 调用对应模型和工具；
- 保存自己的 transcript；
- 返回执行摘要和完整结果。

### 2.3 Manager Clone

Clone是管理者的内部辅助分身，只适合：

- 长篇规划；
- 研究；
- 整理；
- 总结。

Clone不适合：

- 用户代码任务；
- 用户要求的文件修改；
- 代替 execution Agent；
- 再次派发其他 Agent。

当前代码通过 `role: 'manager'`、`role: 'execution'`、`role: 'clone'` 区分三类角色。

---

## 3. 主要源码位置

### 3.1 管理者工具与模型循环

```text
C:\Users\Administrator\Desktop\CCL\AgentsGZT\src\agent\loop.mjs
```

重点函数：

```text
overlayTools()
overlaySystem()
runTool()
runTurn()
runLoop()
boundTools()
```

### 3.2 会话、后台任务与 SSE

```text
C:\Users\Administrator\Desktop\CCL\AgentsGZT\src\agent\chat.mjs
```

重点函数：

```text
handleChat()
startBackgroundJob()
ctx.dispatchWork()
ctx.spawnClone()
handleAbort()
handleSessionEvents()
mutateGroup()
```

### 3.3 能力池和目标选择

```text
C:\Users\Administrator\Desktop\CCL\AgentsGZT\src\agent\dispatch.mjs
```

重点函数：

```text
capabilityPool()
matchPoolEntry()
resolveDispatchTarget()
resolveCloneSlot()
cloneStatus()
```

### 3.4 分区角色

```text
C:\Users\Administrator\Desktop\CCL\AgentsGZT\src\core.mjs
```

重点函数：

```text
isManagerPartition()
isClonePartition()
isExecutionPartition()
workerPartitions()
clonePartitions()
createExecutionPartition()
findIdleExecution()
takeCloneSlot()
```

### 3.5 Transcript和群聊时间线

```text
C:\Users\Administrator\Desktop\CCL\AgentsGZT\src\agent\store.mjs
```

重点函数：

```text
loadTranscript()
saveTranscript()
appendMessage()
loadGroupTimeline()
saveGroupTimeline()
appendGroupEvent()
upsertTaskEvent()
abortTaskEvents()
```

### 3.6 前端事件和页面

```text
C:\Users\Administrator\Desktop\CCL\AgentsGZT\public\app.js
C:\Users\Administrator\Desktop\CCL\AgentsGZT\public\chat.js
```

重点内容：

```text
EventSource 会话事件订阅
session_update
 group_timeline
group_event
clone_result
text_delta
agent_done
tool_call
tool_result
任务卡片渲染
管理者派发卡片渲染
Agent详情页事件过滤
```

---

## 4. 管理者获得的工具

管理者回合会设置：

```js
ctx.managerIdle = Boolean(ctx.isManager && !ctx.isClone);
```

管理者工具包括：

```text
workbench_list_targets
workbench_dispatch
workbench_spawn_clone
```

管理者不会拿到普通 execution 的原生工具。

执行 Agent才会拿到对应供应商或模型系列的工具，例如：

```text
Claude：Read、Write、PowerShell等
Codex：exec_command、write_stdin、apply_patch等
Grok：read_file、write、run_terminal_command等
Gemini：view_file、run_command等
```

`boundTools()`的当前语义：

```text
管理者：只返回管理工具
普通 execution：返回原生工具和必要的附加工具
```

**[已验证事实]**：测试已确认管理者不会携带 execution 的原生文件和终端工具。

---

## 5. 最新的能力池匹配逻辑

### 5.1 能力池信息

`capabilityPool()`现在会收集：

```text
connectionId
连接名称
连接类型
模型系列
系列标签
vendor
默认模型
```

对自定义连接还会通过模型分组识别系列，例如：

```text
自定义连接 + modelGroups: ['claude']
```

会被识别成 Claude 系列能力。

### 5.2 `matchPoolEntry()`支持的匹配方式

系统依次支持：

```text
精确匹配 connectionId
精确匹配连接名称
精确匹配系列标签
精确匹配 vendorLabel
精确匹配 group
精确匹配 vendor
prompt中包含系列或连接名称
```

例如：

```text
用户：让 Grok 写一个脚本
```

可以匹配：

```text
official-grok
```

例如：

```text
用户：让 Codex 运行测试
```

可以匹配：

```text
official-codex
```

如果能力池有多个连接，且 `connectionId` 和 prompt 都无法识别目标，系统返回错误，不随机选择连接。

### 5.3 当前匹配风险

**[风险]**：如果多个能力池项目拥有相同或高度相似的名称，prompt 子串匹配可能产生歧义。

后续可以考虑：

- 返回候选列表让管理者选择；
- 要求管理者先调用 `workbench_list_targets`；
- 对系列名和连接名进行更严格的边界匹配；
- 在工具结果中返回可选目标和歧义原因。

---

## 6. 自定义连接的模型系列工具映射

当前新增了：

```text
pickFamily()
familyToolsFor()
toolFamily
```

对于自定义连接：

```text
自定义连接属于 Claude 系列
```

执行 Agent可以加载 Claude 系列工具。

对于管理者：

```text
即使管理者使用 Claude 系列自定义连接，管理者仍然只拿到 overlay 管理工具
```

这个分层符合产品职责：

```text
管理者负责判断和派发
execution负责实际执行
```

**[代码存在，未完成真实链路验证]**：当前测试已经验证工具数组和模拟调用，但真实供应商是否会稳定按照这些工具定义执行，仍需真实环境验证。

---

## 7. `workbench_dispatch` 的完整调用链

### 7.1 模型发起工具调用

`runTool()`接收到：

```js
{
  name: 'workbench_dispatch',
  args: {
    connectionId,
    partitionId,
    model,
    prompt
  }
}
```

随后转交：

```js
ctx.dispatchWork({
  connectionId,
  partitionId,
  model,
  prompt
});
```

### 7.2 `ctx.dispatchWork()`执行步骤

```text
检查 prompt 是否为空
    ↓
读取当前会话正在运行的分区
    ↓
调用 resolveDispatchTarget()
    ↓
选择或创建 execution 分区
    ↓
持久化分区变化
    ↓
创建 taskId
    ↓
写入 running 任务卡片
    ↓
调用 startBackgroundJob()
    ↓
立即返回 running
```

当前返回结构类似：

```js
{
  ok: true,
  status: 'running',
  taskId,
  partitionId,
  name
}
```

这是异步返回，管理者当前不会等待 execution 完成。

### 7.3 `startBackgroundJob()`执行步骤

```text
创建独立 AbortController
    ↓
注册 execution 运行状态
    ↓
读取分区 route
    ↓
读取 execution transcript
    ↓
构造 execution 上下文
    ↓
设置 isManager: false
    ↓
普通用户任务设置 isClone: false
    ↓
设置 depth: 1
    ↓
把管理者 prompt 设置为 execution userText
    ↓
调用 runTurn(child)
```

关键调用：

```js
const result = await runTurn(child);
```

**[已验证事实]**：代码路径已经把管理者派发的 prompt 传入 execution Agent的真实模型循环。

---

## 8. Execution 完成后的当前行为

普通 execution 完成时，`startBackgroundJob()` 会先将本次结果截取为摘要，然后执行以下路径：

```js
const summary = String(result.text || '').slice(0, 4000);

writeTask(taskId, {
  status: 'completed',
  summary,
  source: 'manager'
});

// 普通 execution 且由管理者派发时：
// 1. 写入群聊 worker 事件；
// 2. 追加 manager transcript 的 dispatch_result；
// 3. 发送 dispatch_result 事件。
```

执行失败时，任务会更新为 `failed`，错误摘要会同时进入任务状态、群聊事件和管理者的 `dispatch_result` 回写路径。

当前普通 execution 的结果会进入：

```text
execution transcript
群聊任务卡片与 worker 事件
manager transcript（kind: dispatch_result，摘要最多约 4000 字符）
前端 SSE 事件（dispatch_result、group_event 等）
```

Clone 完成时会额外：

```text
读取管理者 transcript
追加 kind: clone_result 的消息
发送 clone_result SSE 事件
```

因此，普通 execution 已经有管理者 transcript 回传；当前回传内容主要是截断后的自然语言摘要，尚未形成包含文件变更、工具结果、错误阶段、耗时和重试信息的统一结果对象，也不会自动触发管理者新回合。
---

## 9. 当前最重要的功能缺口

### 9.1 普通 execution 结果已进入管理者 transcript，但结果协议仍不完整

普通 execution 由管理者派发时，管理者 transcript 现在可以继续包含：

```text
用户原始请求
workbench_dispatch 工具调用
workbench_dispatch 返回的 running 状态
管理者当轮回复
execution 完成后的 dispatch_result 摘要
```

其中最后一项实际是由后台任务完成路径追加的 assistant 消息，包含 `kind: 'dispatch_result'`、任务名称、状态、模型和摘要文本。

当前管理者仍不一定能直接读取或可靠利用：

- execution 修改了哪些文件；
- 使用了哪些工具以及工具结果；
- 任务是否部分完成；
- 失败发生在哪个阶段；
- 是否需要继续处理；
- 任务耗时和重试次数；
- 多个并行任务之间的依赖关系。

这里的缺口重点从“是否写回”转为“写回内容是否完整、可消费、可去重”。


### 9.2 execution完成后不会自动重新唤醒管理者

当前没有看到普通 execution完成后自动执行：

```text
建立新的管理者回合
把 execution结果作为新输入
让管理者决定下一步
```

因此当前不支持稳定的：

```text
Agent A完成分析
    ↓
管理者读取结果
    ↓
管理者自动派发 Agent B
    ↓
Agent B完成
    ↓
管理者合并结果并回复用户
```

### 9.3 前端事件、transcript 回写和新管理者回合是三件事

SSE 可以让浏览器显示：

```text
任务开始
任务运行中
任务完成
任务失败
工具调用
```

普通 execution 的摘要也已经会写入管理者 transcript，但以下三件事仍需分别判断：

```text
前端收到状态事件
任务结果持久化并写入 manager transcript
管理者模型开始新的回合并消费结果
```

当前代码已经覆盖前两类中的部分路径，没有自动开始新的管理者回合。浏览器看到 `dispatch_result`，也不代表管理者已经根据该结果继续派发、汇总或向用户发送最终结论。
---

## 10. 重要交互风险：同一会话目标的新消息会中止该目标已有运行

当前 `handleChat()` 会先根据本次消息确定目标，再执行：

```js
const key = runKey(sessionId, isManager, partitionId);
abortRun(sessionId, isManager, partitionId);
```

这条规则的影响范围取决于用户发送消息的目标。当前源码中，管理者回合和普通 execution 后台任务使用不同的运行键：

```text
管理者：sessionId:manager
execution：sessionId:partition-partitionId
```

### 10.1 用户向管理者发送新消息

用户在管理者页面发送消息时，调用的是：

```text
abortRun(sessionId, true, '')
```

它会中止当前管理者回合，但不会直接中止已经登记为 `sessionId:partition-partitionId` 的后台 execution 任务。后台 execution 是否继续，仍由它自己的 `AbortController` 和任务状态决定。

### 10.2 用户向正在执行的 Agent 分区发送新消息

用户进入 Agent A 详情页并发送消息时，调用的是：

```text
abortRun(sessionId, false, partitionId)
```

由于它与管理者派发给 Agent A 的后台任务共用：

```text
sessionId:partition-partitionId
```

当前行为是：

```text
管理者把任务派给 Agent A
    ↓
Agent A 在后台执行
    ↓
用户进入 Agent A 详情页并发送消息
    ↓
handleChat() 中止该 execution 的当前运行
    ↓
旧任务被记录为失败或被用户中止
    ↓
同一 Agent 分区开始处理用户新消息
```

**[已验证事实]**：用户向管理者发送消息不会直接中止后台 execution；用户向同一 execution 分区发送消息，会中止该 execution 当前运行后处理新消息。这里中止的是目标分区的运行，不是一个抽象的“原管理者任务”整体。

**[风险]**：当前界面和任务协议没有清楚标明任务来源、是否允许打断、旧任务如何恢复、用户新消息是否应进入管理者后续判断。用户可能把“Agent 详情页可发送消息”理解为追加指令，系统却执行了中止并改写为新的分区回合。

### 推荐处理策略

第一版需要明确选择以下规则之一：

#### 方案 A：管理者占用期间禁止直接发送

```text
Agent 正在执行管理者任务时，用户不能直接向该分区发送新消息
```

优点：状态最简单，避免用户无意中止任务。缺点：用户无法在执行期间补充信息。

#### 方案 B：用户消息排队

```text
管理者任务继续执行；用户追加消息进入该分区队列
任务完成或进入可接收状态后，再执行排队消息
```

优点：保留追加指令能力，不改变当前任务结果。缺点：需要队列状态、顺序和取消规则。

#### 方案 C：为用户消息创建独立运行

```text
旧 task 保留
用户消息创建新的 runId
两个运行分别显示结果
```

优点：能够并行保留管理者任务和用户任务。缺点：需要将运行记录从当前的单一 `jobKey` 改为 `runId` 管理，并明确同一分区的资源并发限制。

当前不建议继续保留“用户发送消息就隐式中止旧运行”的无提示行为。产品至少应在发送前显示任务来源、运行状态和中止后果；在没有 `runId`、队列或明确禁用规则前，优先采用方案 A 或方案 B。

---
## 11. 运行记录竞态风险

后台任务启动时会：

```js
abortRun(sessionId, false, partition.id);
runs.set(jobKey, newRun);
```

后台任务结束时会：

```js
runs.delete(jobKey);
```

可能发生：

```text
旧任务仍在收尾
    ↓
新任务登记到同一个 jobKey
    ↓
旧任务 finally执行
    ↓
旧任务删除 jobKey
    ↓
新任务的运行记录消失
```

可能导致：

- 新任务实际运行，但 `busyPartitionIds()`认为它空闲；
- 同一个 Agent被重复复用；
- 停止操作找不到新任务；
- 任务卡片和运行状态不一致。

建议每次运行生成 `runId`，结束时只删除属于当前运行的记录：

```js
if (runs.get(jobKey)?.runId === currentRunId) {
  runs.delete(jobKey);
}
```

---

## 11.1 管理者 transcript 并发覆盖风险

管理者普通回合和后台 execution 完成回写，都可能对固定的 `manager` transcript 执行：

```text
读取 manager.json
    ↓
追加消息
    ↓
写回 manager.json
```

`saveTranscript()`当前使用固定的临时文件名 `manager.json.tmp`。如果普通管理者回合与后台任务同时完成，可能出现：

```text
回合 A读取旧 transcript
回合 B读取旧 transcript
回合 A写回
回合 B基于旧内容写回
    ↓
A或B的新增消息被覆盖
```

固定临时文件还可能在并发写入时发生互相覆盖或重命名冲突。

**[风险]**：这是根据当前读—改—写代码路径推断出的风险，现有 186 个测试没有证明并发回写安全。

**[建议]**：第一阶段按 `sessionId + targetKey` 建立单写入队列；后续可增加版本号校验、冲突重读重试或追加式事件存储。临时文件名也应包含本次写入的唯一标识。

---

## 12. 群聊时间线并发写入风险

当前 `mutateGroup()`流程是：

```text
读取 group.json
    ↓
修改内存对象
    ↓
整体写回 group.json
```

两个 execution同时完成时，可能发生：

```text
任务 A读取旧文件
任务 B读取旧文件
任务 A写回
任务 B写回并覆盖 A 的事件
```

当前测试覆盖任务卡片创建、更新和中止，但还没有证明两个后台任务同时完成时不会丢事件。

建议后续增加：

- 单会话写入队列；
- 文件锁；
- 事件追加日志；
- SQLite；
- 版本号与冲突重试。

第一阶段可以先使用单会话写入队列，避免立即引入数据库。

---

### 12.1 SSE 事件可靠性缺口

**[已验证事实]**：当前前端已经订阅会话 SSE，并处理 `group_timeline`、`group_event`、`dispatch_result`、`clone_result`、`text_delta`、`agent_done`、`tool_call`、`tool_result` 等事件；当前测试也覆盖了部分事件路由、任务卡片和 Agent 详情过滤。

**[风险]**：当前事件虽然部分载荷带有事件 ID，但尚未形成统一的投递协议，仍缺少以下明确约束：

- 统一的 `eventId`、顺序号和 `runId`；
- 断线重连时的游标或 `Last-Event-ID` 语义；
- 历史事件补发范围；
- 重复事件去重；
- 事件与任务、分区、尝试次数之间的稳定关联。

因此，浏览器断线、重复订阅或两个后台任务接近同时完成时，仍可能出现重复显示、顺序不一致或缺少事件。当前测试没有证明断线恢复和并发事件不丢失。

**[建议]**：统一 SSE 事件外层结构，例如 `{ eventId, seq, sessionId, type, taskId, runId, createdAt, payload }`；持久化可补发的事件；客户端按 `eventId` 去重并按游标请求缺失事件。

---

## 13. 路由可用性检查偏晚

传入已有 `partitionId`时，当前目标选择主要检查：

```text
分区是否存在
分区是否正在运行
```

真正的 route可用性检查主要在后台启动阶段由 `pickRoute()`执行。

可能出现：

```text
任务先显示 running
    ↓
后台启动
    ↓
发现连接过期、密钥缺失或 route失效
    ↓
任务变为 failed
```

建议创建任务前检查：

- connection是否存在；
- 官方账号是否有效；
- 自定义连接是否存在密钥；
- model是否属于连接；
- execution分区是否存在可用 route。

---

## 14. 管理者 transcript 与模型切换风险

管理者 transcript使用固定目标键：

```text
manager
```

管理者实际模型来自全局：

```text
state.manager
```

如果管理者模型从 Claude切换到 Grok，仍可能读取同一个 manager transcript。

这会产生两种可能的产品语义：

### 方案 A：所有管理者共享一个历史

优点：

- 切换模型后会话连续；
- 用户可以保留完整上下文。

风险：

- 不同模型的工具格式和能力说明可能混在一起；
- 前一个模型留下的工具调用记录可能影响后一个模型。

### 方案 B：按模型系列拆分历史

例如：

```text
manager-claude
manager-grok
manager-codex
manager-gemini
```

优点：

- 工具格式和模型上下文边界清晰。

风险：

- 切换模型后需要生成摘要或重新建立上下文。

**[待决策]**：当前源码保留了共用 `manager` transcript的形态，产品需要确定是否继续采用。

---

## 15. 当前任务数据模型

当前主要使用：

```text
sessionId
partitionId
taskId
status
summary
source
```

建议补充：

```text
runId        一次具体执行
eventId      一条状态或消息事件
attempt      第几次尝试
parentTaskId 父任务
resultRef    完整结果引用
createdAt    任务创建时间
completedAt  任务完成时间
```

建议语义：

```text
taskId：用户层面的任务
runId：该任务的一次执行
attempt：当前执行次数
eventId：一条可去重的事件
parentTaskId：父子任务关系
```

示例：

```text
taskId = task-001
runId = run-001
attempt = 1
status = failed

同一任务重试：

taskId = task-001
runId = run-002
attempt = 2
status = completed
```

---

## 16. 建议的统一执行结果

每次 execution完成后，建议生成：

```js
{
  taskId: 'task-001',
  runId: 'run-001',
  parentTaskId: null,
  partitionId: 'partition-001',
  agentName: 'Grok',

  status: 'completed',
  summary: '已完成页面修改并通过检查',
  fullResult: '完整自然语言结果，或完整结果的引用',
  resultRef: null,

  changedFiles: [
    'src/example.js',
    'public/index.html'
  ],
  toolResults: [],
  error: null,

  attempt: 1,
  createdAt: '2026-09-18T10:00:00.000Z',
  completedAt: '2026-09-18T10:08:00.000Z'
}
```

各界面职责建议：

| 位置 | 展示内容 |
|---|---|
| 群聊总览 | 状态、摘要、目标 Agent、完成时间、失败原因 |
| Agent详情 | 完整 transcript、工具调用、工具结果、文件变更 |
| 管理者上下文 | 结构化结果、摘要、错误和后续决策所需信息 |

---

## 17. 建议的结果回传方案

### 17.1 第一阶段：用户下一次询问时注入结果

建议先采用：

```text
execution完成
    ↓
保存结构化结果
    ↓
群聊显示摘要
    ↓
用户下一次询问管理者
    ↓
系统把未读 execution结果注入管理者上下文
    ↓
管理者决定下一步
```

优点：

- 不会在用户没有操作时额外触发模型调用；
- 逻辑容易测试；
- 便于限制重复处理；
- 适合作为第一版闭环。

### 17.2 第二阶段：结果完成后自动唤醒管理者

流程：

```text
execution完成
    ↓
结果事件进入管理者协调队列
    ↓
管理者读取结果
    ↓
管理者决定继续派发或汇总
```

必须增加：

- 自动唤醒开关；
- 最大自动轮数；
- 并行任务聚合规则；
- 失败和重试上限；
- 防止管理者无限派发；
- 用户取消后的阻断规则；
- 任务间依赖关系。

当前不建议直接从异步后台任务无限制自动唤醒管理者。

---

## 18. 当前测试结果

本轮复核时间：`2026-09-18 20:50 +08:00`。

执行命令：

```powershell
npm test
npm run check
```

当前结果：

```text
npm test：186 个测试通过
0 个失败
0 个取消
0 个跳过
0 个 todo

npm run check：通过
```

`npm test`证明本地测试契约和模拟流程通过；`npm run check`证明列出的 JavaScript 文件语法检查通过。两者都不能证明真实供应商调用、真实浏览器交互、真实并发和断线恢复已经完成验证。

### 18.1 已覆盖内容

当前测试已经覆盖：

- 管理者工具存在；
- 管理者不带 execution 原生工具；
- 管理者与能力池模型系列隔离；
- 自定义 Grok 管理者身份不跟能力池中的 Claude 型号混用；
- custom Responses 管理者调用 `workbench_dispatch`；
- custom Responses 管理者调用 `workbench_spawn_clone`；
- Claude 系列自定义 execution 获得系列工具；
- 管理者派同系列任务使用 execution，而不是 clone；
- 按连接名、产品标签或 prompt 匹配能力池；
- 多连接时根据 prompt 选择正确产品；
- 空闲 execution 复用；
- 忙碌 execution 不会被复用；
- 忙碌时可创建新的 execution；
- clone 最多两个并发槽位；
- 任务卡片创建、更新和停止；
- 群聊时间线事件；
- 管理者 overlay 工具渲染成派发卡片；
- SSE 事件路由和 Agent 详情过滤；
- 前端 `dispatch_result` 写入管理者视图并渲染完成状态；
- `clone_result` 只写入管理者视图；
- `dispatch_result` 写入管理者视图，普通 execution 结果同时出现在群聊；
- `scrollChatToLatest` 将对话日志和群聊日志滚动到最新内容；
- 点击会话后进入群聊并展开 AI 列表；
- 点击任务卡片或 Agent 分区后进入对应 Agent 详情；
- 返回群聊和页面结构。

### 18.2 尚未由当前测试证明的内容

当前仍缺少完整端到端测试证明：

```text
真实管理者模型调用派发
    ↓
真实后台 execution 完成
    ↓
结构化结果保存
    ↓
结果进入真实管理者下一次输入
    ↓
管理者继续派发或汇总
```

当前已有的 `dispatch_result` 测试主要验证前端事件处理、管理者视图过滤和卡片渲染；它没有证明真实后台 execution 完成后，模型下一回合会消费该结果。

还缺少：

- 两个后台 execution 并行完成且事件不丢失；
- manager transcript 并发回写不覆盖消息；
- 群聊时间线并发写入不丢事件；
- 用户直接消息与管理者任务同时发生；
- 旧任务中止后立即新建任务；
- `runs.delete(jobKey)` 不会误删新任务记录；
- route 检查失败时不会先留下误导性的 running 状态；
- SSE 断开后重连、历史补发、顺序保持和重复事件去重；
- 普通 execution 后台完成到 manager transcript 回写的真实集成链路；
- 管理者下一次模型回合实际消费 `dispatch_result`；
- 管理者模型切换后的历史兼容；
- 真实浏览器视觉交互；
- 真实供应商的工具调用遵循情况。

---

## 19. 后续实施优先级

### P0-1：确定 execution 运行期间的用户消息规则

优先处理用户直接消息可能中断管理者任务的问题。

建议第一版采用以下两种明确规则之一：

```text
execution 正在执行管理者任务时，暂时禁止直接发送新消息
```

或者：

```text
追加消息进入队列，不中断当前任务
```

当前不建议继续保留“用户发送消息就隐式中止旧任务”的无提示行为。

### P0-2：补齐普通 execution 结果协议和管理者消费方式

必须先明确：

- 统一执行结果结构；
- 结果保存位置；
- `dispatch_result` 的结构化字段、去重方式和已处理标记；
- 管理者下一次询问时如何读取未处理结果；
- 群聊摘要和 Agent 详情的展示边界；
- 失败、部分完成和需要人工确认的状态；
- 采用“用户下一次询问时消费”，还是“受控自动唤醒管理者”。

第一版建议采用“用户下一次询问时消费”，降低额外模型调用、无限派发和并发写入风险。

### P1：增加运行级标识并修复并发写入

补充：

```text
runId
eventId
attempt
parentTaskId
resultRef
```

同时处理：

- 旧任务结束时误删新任务 `runs` 记录；
- manager transcript 的并发覆盖；
- 群聊时间线的并发覆盖；
- 每会话事件写入串行化。

### P1：补齐事件、路由、重试和中止测试

至少覆盖：

1. 两个 execution 同时完成且事件不丢失；
2. 一个任务失败后重试且旧结果不覆盖新结果；
3. 用户发送追加消息；
4. 旧任务中止后立即新建任务；
5. 用户停止群聊全部任务；
6. SSE 断线、重连、补发和去重；
7. 管理者模型切换；
8. 管理者在下一次询问时消费未处理结果。

### P1：提前检查 route

在任务进入 `running` 前确认连接、密钥、模型和 route 可用，避免先显示运行中再立即失败。

### P2：再考虑完整多 AI 群聊

当前群聊继续展示：

```text
用户消息
管理者回复
任务卡片
任务状态
系统备注
```

Execution Agent 的完整过程保留在独立 Agent 详情页。

只有产品确认需要真实多 AI 连续对话后，再增加：

- execution 连续发言；
- 流式消息；
- 发言与 taskId 关联；
- 管理者插话；
- Agent 之间公开传递消息；
- 点击发言跳转执行详情。

---

## 20. 后续 AI 修改前检查清单

```text
[ ] 重新读取 src/agent/loop.mjs
[ ] 重新读取 src/agent/chat.mjs
[ ] 重新读取 src/agent/dispatch.mjs
[ ] 重新读取 src/agent/store.mjs
[ ] 重新读取 src/core.mjs
[ ] 重新执行 npm test
[ ] 重新执行 npm run check
[ ] 确认当前测试数量和失败情况
[ ] 判断修改属于 P0、P1还是 P2
[ ] 不要把 clone当作 execution
[ ] 不要把 SSE 前端事件、manager transcript 回写和新的管理者回合混为一谈
[ ] 不要把 `dispatch_result` 回写误认为管理者已经开始新回合
[ ] 不要只更新任务卡片而遗漏结果保存
[ ] 不要让用户追加消息无提示地中止目标 execution 运行
[ ] 不要使用固定 jobKey 删除可能属于新任务的运行记录
[ ] 不要让 manager transcript 和群聊时间线并发写入时互相覆盖
[ ] 修改后补充失败、并发、重试、断线和重复事件测试
[ ] 不要修改无关的供应商官方调用链
```

---

## 21. 一句话交接结论

当前管理者 AI 已经能够根据产品系列、连接名称、模型和 prompt 选择目标，创建或复用 execution 分区，启动真实 execution 模型循环，并把普通 execution 的摘要回写到 manager transcript；但结果回写不会自动开启管理者新回合。下一阶段应先确定执行期间的用户消息规则，补齐结构化结果、运行标识和 SSE 事件协议，修复 transcript、群聊时间线与运行记录的并发风险，再决定管理者采用“用户下一次询问时消费”还是“受控自动唤醒”继续安排后续任务。






