# CodeBuddy Agent v2.0.0

自主代码修复 Agent：读取失败的单元测试 → 规划 → 真实工具调用改代码 → **由 harness 独立验证** → 把根因写进长期记忆。

不是演示脚本。每一步都由真实模型响应驱动，没有硬编码轨迹。

---

## 这个版本包含什么

- **四阶段运行时**：规划 → ReAct 工具循环 → 独立验证 → 反思。分层为 Provider / Agent Loop / Tool Registry，新增工具只需注册 schema 与实现。
- **真实工具调用**：走 OpenAI 兼容接口的 function calling，模型自己决定每次调用什么工具。
- **独立验证**：验证由 harness 自己跑真实测试并回读结果，**不采信模型的自我陈述**。
- **长期记忆**：反思结果持久化，供后续任务召回。
- **可复现评测框架**：固定基准任务集，输出成功数、迭代轮次、工具调用、token 与耗时，报告带时间戳归档。
- **两种形态**：VS Code 扩展（Activity Bar 侧边栏）与 CLI。

## 边界条件是被写进架构的

| 失败模式 | 处理 |
|---|---|
| 跑不完 | 迭代次数硬上限（默认 12，可配 1–50） |
| 陷入死循环 | 字节归一化重复检测 + 两次调用成环检测 + 无进展追踪 |
| 工具参数非法 | handler 执行前先过 JSON Schema 校验 |
| 补丁打到错的位置 | 精确匹配 → 空白容忍匹配 → **有歧义就拒绝写入** |
| 路径逃出工作区 | 每个路径都解析并限制在工作区根目录内 |
| 危险操作 | 危险命令拦截，写文件与执行命令二次确认 |
| 成本失控 | token 预算节流器 + 用量先预留后结算 |

## 测试

```
npm test           → 62 个单元测试，7 个测试文件，全部通过
npm run typecheck  → TypeScript 严格模式，零错误
npm run build      → 编译产出 dist/（本版修复）
```

## 本版修复

- **修复 `npm run build` 失败**：`tsconfig.json` 缺少 `rootDir`，导致 `tsc` 报 `TS5011` 并以退出码 2 结束。此前 `npm test` 与 `npm run typecheck` 都不受影响，因此该问题长期未被发现。
- **打包内容收窄**：`.vscodeignore` 现在排除 `docs/`、`.codebuddy/`、vitest 配置、`.gitignore` 与编译后的测试文件。安装包从 144 个文件 / 334 KB 降到 **27 个文件 / 65 KB**。

## 安装

**方式一 · 从本 Release 安装（推荐）**

下载下方 `codebuddy-agent-2.0.0.vsix`，然后：

```
code --install-extension codebuddy-agent-2.0.0.vsix
```

或在 VS Code 里：扩展面板 → 右上角 `...` → **Install from VSIX...**

**方式二 · 从源码运行**

```bash
git clone https://github.com/BOHAOYUAN/CodeBuddy.git
cd CodeBuddy && npm install
npm test
npm start
```

## 配置

在工作区根目录的 `.env` 里填：

```
PROVIDER_BASE_URL=https://api.deepseek.com
PROVIDER_API_KEY=your-key-here
PROVIDER_MODEL=deepseek-flash
```

`PROVIDER_*` 全部参数（含 `AGENT_MAX_ITERATIONS`、`AGENT_TPM_LIMIT`、
`AGENT_PRICE_IN_PER_MTOK` 等）见仓库内 `.env.example`。

## 已知限制

我把自己系统的坏点写在 README 的 **Known limitations** 一节里，请先读那一节再评估它：

- 评测基准很小：每个任务是一个函数 + 一个测试文件，没有验证过多文件改动或构建流程
- 长期记忆里的反思由模型生成，即使修复成功，记录的根因也可能是错的
- 只测过一个模型家族（`openai/gpt-oss-120b`）
- 扩展目前只在自己的目录内工作，还不会去修用户的项目——这是刻意的范围边界

---

MIT License
