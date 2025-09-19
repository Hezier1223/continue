# 手动输入追踪功能 (Manual Typing Tracker)

## 功能概述

本次实现了一个完整的手动输入追踪系统，用于监控和统计用户在 VSCode 编辑器中的手动输入行为。该系统能够准确区分手动输入和自动补全，并提供详细的统计数据和上报功能。

## 核心特性

### 1. 精确的手动输入检测

- 通过拦截 VSCode 的 `type` 命令来捕获所有手动输入
- 100% 准确识别手动输入，避免与自动补全混淆
- 支持实时追踪字符输入、行数变化和光标位置

### 2. 全面的统计功能

- **基础统计**: 总字符数、总行数、总按键数
- **会话统计**: 输入会话数、平均会话长度
- **文件统计**: 按文件统计输入量、最活跃文件识别
- **语言统计**: 按编程语言统计输入分布
- **时间统计**: 按小时统计输入活跃度

### 3. 智能会话管理

- 自动检测输入会话的开始和结束
- 2秒无输入自动结束当前会话
- 支持会话级别的统计和分析

### 4. 数据上报系统

- 批量上报机制，提高性能
- 定期上报（默认5分钟间隔）
- 失败重试机制
- 与 Shihuo 平台集成

## 技术架构

### 核心组件

#### 1. ManualTypingConfig (`ManualTypingConfig.ts`)

```typescript
interface ManualTypingConfig {
  enabled: boolean; // 是否启用追踪
  reportEnabled: boolean; // 是否启用上报
  reportInterval: number; // 上报间隔(ms)
  batchSize: number; // 批处理大小
}
```

#### 2. ManualTypingStatisticsService (`ManualTypingStatisticsService.ts`)

- 单例模式管理统计服务
- 实时更新统计信息
- 管理输入会话生命周期
- 处理数据上报逻辑

#### 3. ManualTypingTracker (`manualTypingTracker.ts`)

- VSCode 扩展集成层
- 拦截 `type` 命令
- 处理编辑器事件
- 提供用户界面接口

### 数据流

```
用户输入 → type命令拦截 → ManualTypingTracker → ManualTypingStatisticsService → 统计更新 + 数据上报
```

## 实现细节

### 1. 命令拦截机制

```typescript
// 注册type命令监听器来捕获所有手动输入
this.typeCommandDisposable = vscode.commands.registerCommand("type", (args) => {
  this.handleManualTyping(args);
  // 调用原始的type命令
  return vscode.commands.executeCommand("default:type", args);
});
```

### 2. 会话管理

```typescript
// 检查是否需要开始新的输入会话
if (!this.currentSessionId || now - this.statistics.lastTypingTime > 2000) {
  this.startNewSession();
}
```

### 3. 数据上报

```typescript
// 上传到 Shihuo 平台
const response = await fetch(
  "https://sh-gateway.shihuo.cn/v4/services/sh-elance-api/track/auto_track",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: paramsStr }),
    signal: AbortSignal.timeout(10000),
  },
);
```

## 用户界面

### 命令支持

- `continue.showManualTypingStats`: 显示手动输入统计信息
- 支持通过命令面板或快捷键调用

### 统计信息展示

```
手动输入统计:
总字符数: 1250
总行数: 45
总按键数: 1250
输入会话数: 12
平均会话长度: 1500ms
最活跃文件: /path/to/file.ts
最活跃文件字符数: 500
最后输入时间: 2024-01-15 14:30:25
```

## 配置选项

### 默认配置

```typescript
const DEFAULT_MANUAL_TYPING_CONFIG = {
  enabled: true,
  reportEnabled: true,
  reportInterval: 5 * 60 * 1000, // 5分钟
  batchSize: 10,
};
```

### 可配置项

- **enabled**: 启用/禁用追踪功能
- **reportEnabled**: 是否启用数据上报
- **reportInterval**: 上报间隔时间
- **batchSize**: 批处理大小

## 测试覆盖

### 单元测试 (`ManualTypingStatisticsService.test.ts`)

- 手动输入追踪测试
- 文件统计测试
- 语言统计测试
- 会话管理测试

### 测试用例

```typescript
test("should track manual typing", () => {
  service.trackManualTyping(
    "test.ts",
    "ts",
    5,
    1,
    { line: 0, character: 0 },
    "hello",
  );
  const stats = service.getStatistics();
  expect(stats.totalCharactersTyped).toBe(5);
});
```

## 集成方式

### VSCode 扩展集成

1. 在 `VsCodeExtension.ts` 中初始化追踪器
2. 在 `commands.ts` 中注册统计显示命令
3. 在 `package.json` 中定义命令配置

### 核心模块集成

- 与 Continue 核心模块无缝集成
- 支持配置管理和状态同步
- 兼容现有的自动补全系统

## 性能优化

### 1. 批量处理

- 事件批量上报，减少网络请求
- 队列管理，避免内存泄漏

### 2. 异步处理

- 非阻塞的数据处理
- 超时控制，避免长时间等待

### 3. 内存管理

- 及时清理过期数据
- 单例模式，避免重复实例化

## 隐私和安全

### 数据保护

- 本地统计，敏感信息不上报
- 用户可控制数据上报开关
- 支持统计信息重置

### 网络安全

- HTTPS 加密传输
- 请求超时控制
- 错误处理和重试机制

## 未来扩展

### 可能的增强功能

1. **可视化仪表板**: 提供更丰富的统计图表
2. **个性化分析**: 基于用户习惯的智能分析
3. **团队协作**: 支持团队级别的统计对比
4. **导出功能**: 支持统计数据的导出和分析

### 技术优化

1. **性能监控**: 添加性能指标追踪
2. **缓存机制**: 优化大数据量处理
3. **插件化**: 支持第三方插件扩展

## 总结

手动输入追踪功能为 Continue 项目增加了一个重要的用户行为分析能力。通过精确的手动输入检测、全面的统计功能和可靠的数据上报机制，该系统能够为产品优化和用户体验改进提供有价值的数据支持。

该实现遵循了良好的软件工程实践，包括单例模式、配置管理、错误处理和测试覆盖，确保了系统的稳定性和可维护性。
