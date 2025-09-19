import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Position } from "../../index";

export interface ManualTypingStatistics {
  totalCharactersTyped: number;
  totalLinesTyped: number;
  totalKeystrokes: number;
  lastTypingTime: number;
}

export interface ManualTypingEvent {
  type: "keystroke";
  timestamp: number;
  filepath: string;
  fileExtension: string;
  charactersAdded: number;
  linesAdded: number;
  position: Position;
  text: string;
}

export interface ManualTypingConfig {
  enabled: boolean;
  reportEnabled: boolean;
  reportInterval: number; // 上报间隔(ms)
  batchSize: number; // 批处理大小
  retryAttempts: number;
  retryDelay: number;
  maxRetryDelay: number;
  requestTimeout: number;
}

export const DEFAULT_CONFIG: ManualTypingConfig = {
  enabled: true,
  reportEnabled: true,
  reportInterval: 5 * 60 * 1000, // 5分钟
  batchSize: 10,
  retryAttempts: 3,
  retryDelay: 1000,
  maxRetryDelay: 30000,
  requestTimeout: 10000,
};

export class ManualTypingStatisticsService {
  private static instance: ManualTypingStatisticsService | undefined;

  private statistics: ManualTypingStatistics = {
    totalCharactersTyped: 0,
    totalLinesTyped: 0,
    totalKeystrokes: 0,
    lastTypingTime: 0,
  };

  // 配置管理
  private config: ManualTypingConfig = DEFAULT_CONFIG;

  private reportQueue: ManualTypingEvent[] = [];
  private reportTimer: NodeJS.Timeout | null = null;
  private failedEvents: ManualTypingEvent[] = [];
  private lastCleanupTime: number = 0;

  // 固定配置常量 - 使用更高效的数值
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5分钟清理一次
  private readonly MAX_QUEUE_SIZE = 1000;

  // 缓存常用值
  private readonly RETRYABLE_ERRORS = new Set([
    "AbortError",
    "timeout",
    "network",
    "ECONNRESET",
    "ENOTFOUND",
    "ECONNREFUSED",
  ]);
  private readonly MAX_FAILED_EVENTS_MULTIPLIER = 2;

  private constructor() {
    this.startPeriodicReporting();
  }

  public static getInstance(): ManualTypingStatisticsService {
    if (!ManualTypingStatisticsService.instance) {
      ManualTypingStatisticsService.instance =
        new ManualTypingStatisticsService();
    }
    return ManualTypingStatisticsService.instance;
  }

  /**
   * 追踪用户手敲的字符
   */
  public trackManualTyping(
    filepath: string,
    fileExtension: string,
    charactersAdded: number,
    linesAdded: number,
    position: Position,
    text: string,
  ): void {
    // 输入验证
    if (!this.validateInput(filepath, charactersAdded, linesAdded, text)) {
      return;
    }

    const now = Date.now();

    // 批量更新统计信息
    this.updateStatisticsBatch(charactersAdded, linesAdded, now);

    // 创建事件并加入队列
    const event: ManualTypingEvent = {
      type: "keystroke",
      timestamp: now,
      filepath,
      fileExtension,
      charactersAdded,
      linesAdded,
      position,
      text,
    };

    this.queueForReporting(event);

    // 定期清理
    this.performPeriodicCleanup(now);
  }

  /**
   * 获取当前统计信息
   */
  public getStatistics(): ManualTypingStatistics {
    return { ...this.statistics };
  }

  /**
   * 重置统计信息
   */
  public resetStatistics(): void {
    this.statistics = {
      totalCharactersTyped: 0,
      totalLinesTyped: 0,
      totalKeystrokes: 0,
      lastTypingTime: 0,
    };
  }

  /**
   * 上报成功后重置统计数据
   */
  private resetStatisticsAfterReport(): void {
    this.statistics.totalCharactersTyped = 0;
    this.statistics.totalLinesTyped = 0;
    this.statistics.totalKeystrokes = 0;
    // 保留 lastTypingTime 不变，用于判断输入间隔
  }

  /**
   * 将事件加入上报队列
   */
  private queueForReporting(event: ManualTypingEvent): void {
    // 队列大小限制
    if (this.reportQueue.length >= this.MAX_QUEUE_SIZE) {
      this.reportQueue.shift();
      console.warn(`Report queue full, discarded oldest event`);
    }

    this.reportQueue.push(event);

    // 如果队列满了，立即上报
    if (this.reportQueue.length >= this.config.batchSize) {
      this.reportEvents();
    }
  }

  /**
   * 开始定期上报
   */
  private startPeriodicReporting(): void {
    if (this.config.reportEnabled) {
      this.reportTimer = setInterval(() => {
        this.reportEvents();
      }, this.config.reportInterval);
    }
  }

  /**
   * Flush the report queue
   */
  private async reportEvents(): Promise<void> {
    // 合并正常队列和失败重试队列
    const allEventsToReport = [...this.failedEvents, ...this.reportQueue];

    console.log("allEventsToReport", allEventsToReport);

    if (allEventsToReport.length === 0) return;

    // 清空队列
    this.reportQueue = [];
    this.failedEvents = [];

    try {
      await this.sendReport({
        events: allEventsToReport,
        ...this.statistics,
      });
      console.log(
        `Successfully reported ${allEventsToReport.length} manual typing events`,
      );

      // 上报成功后重置统计数据
      this.resetStatisticsAfterReport();
    } catch (error) {
      console.warn("Failed to report manual typing data:", error);
      // 将失败的事件加入失败队列，避免与新事件混合
      this.failedEvents.push(...allEventsToReport);

      // 如果失败队列过大，丢弃最老的事件以避免内存泄漏
      const maxFailedEvents =
        this.config.batchSize * this.MAX_FAILED_EVENTS_MULTIPLIER;
      if (this.failedEvents.length > maxFailedEvents) {
        const toDiscard = this.failedEvents.length - maxFailedEvents;
        this.failedEvents.splice(0, toDiscard);
        console.warn(
          `Discarded ${toDiscard} old failed events to prevent memory leak`,
        );
      }
    }
  }

  /**
   * Send report to remote server using the same format as uploadLog
   */
  private async sendReport(payload: any) {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        await this.uploadLog(payload);
        return;
      } catch (error) {
        lastError = error as Error;

        // 检查是否可重试
        if (!this.isRetryableError(error)) {
          console.error("Non-retryable error:", error);
          throw error;
        }

        console.warn(`Report attempt ${attempt} failed:`, error);

        if (attempt < this.config.retryAttempts) {
          // 指数退避重试
          const delay = Math.min(
            this.config.retryDelay * Math.pow(2, attempt - 1),
            this.config.maxRetryDelay,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    console.error(`All ${this.config.retryAttempts} attempts failed`);
    throw lastError;
  }

  /**
   * Upload log using the same format as the existing telemetry system
   */
  private async uploadLog(log: Record<string, any>) {
    try {
      // 获取用户信息（从Shihuo Session或环境变量）
      const userInfo = await this.getUserInfoFromSession();
      const deviceId = this.getOrCreateDeviceId();

      const bizData = {
        ...log,
        name: userInfo.name,
        dept_name: userInfo.dept_name,
      };

      console.log("Manual typing bizData", bizData);

      const params: Record<string, any> = {
        pti: {
          id: "continue_manual_typing", // 使用Continue手动输入的标识
          biz: JSON.stringify(bizData),
        },
        device_id: deviceId,
        client_code: userInfo.name,
        channel: "Continue", // 使用Continue作为渠道
        action_time: new Date().getTime(),
        APIVersion: "0.6.0",
      };

      const paramsStr =
        "?" +
        Object.entries(params)
          .map(([key, value]) => {
            const stringValue =
              typeof value === "object" ? JSON.stringify(value) : String(value);
            return `${key}=${encodeURIComponent(stringValue)}`;
          })
          .join("&");

      const response = await fetch(
        "https://sh-gateway.shihuo.cn/v4/services/sh-elance-api/track/auto_track",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: paramsStr }),
          signal: AbortSignal.timeout(this.config.requestTimeout),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Response error:", errorText);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // 检查响应是否有内容
      const responseText = await response.text();
      if (responseText.trim()) {
        try {
          JSON.parse(responseText);
        } catch (parseError) {
          // 即使不是JSON，如果状态码是200，我们也认为请求成功了
        }
      }
    } catch (error) {
      console.error("Upload log error:", error);
      throw error;
    }
  }

  /**
   * Get user info from Shihuo session or fallback to environment variables
   */
  private async getUserInfoFromSession(): Promise<{
    name: string;
    dept_name: string;
  }> {
    try {
      // 尝试从Shihuo Session获取用户信息
      const { getShihuoSessionInfo } = await import(
        "../../../extensions/vscode/src/stubs/ShihuoAuthProvider"
      );
      const sessionInfo = await getShihuoSessionInfo(true); // silent = true

      if (sessionInfo && "account" in sessionInfo && sessionInfo.account) {
        return {
          name: sessionInfo.account.label || "",
          dept_name: "", // Shihuo session可能不包含部门信息
        };
      }
    } catch (error) {
      console.warn("Failed to get user info from Shihuo session:", error);
    }

    // 回退到环境变量
    return {
      name: process.env.USER_NAME || "",
      dept_name: process.env.DEPT_NAME || "",
    };
  }

  /**
   * 获取或创建设备ID - 使用Continue的全局数据目录
   */
  private getOrCreateDeviceId(): string {
    const deviceIdPath = this.getDeviceIdPath();

    try {
      // 尝试从文件读取现有的deviceId
      if (fs.existsSync(deviceIdPath)) {
        const deviceId = fs.readFileSync(deviceIdPath, "utf8").trim();
        if (deviceId) {
          return deviceId;
        }
      }

      // 如果不存在，生成新的deviceId
      const deviceId = this.generateDeviceId();

      // 确保目录存在
      const deviceIdDir = path.dirname(deviceIdPath);
      if (!fs.existsSync(deviceIdDir)) {
        fs.mkdirSync(deviceIdDir, { recursive: true });
      }

      // 保存到文件
      fs.writeFileSync(deviceIdPath, deviceId, "utf8");
      return deviceId;
    } catch (error) {
      console.warn("无法读写设备ID文件，使用临时ID:", error);
      return this.generateDeviceId();
    }
  }

  /**
   * 获取Continue数据目录路径
   */
  private getContinueDataPath(): string {
    try {
      const continueGlobalDir =
        process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), ".continue");
      const devDataPath = path.join(continueGlobalDir, "dev_data");
      const versionPath = path.join(devDataPath, "0.2.0");

      if (!fs.existsSync(versionPath)) {
        fs.mkdirSync(versionPath, { recursive: true });
      }

      return versionPath;
    } catch {
      // 回退到简单路径
      const fallbackPath = path.join(process.cwd(), ".continue");
      if (!fs.existsSync(fallbackPath)) {
        fs.mkdirSync(fallbackPath, { recursive: true });
      }
      return fallbackPath;
    }
  }

  /**
   * 获取设备ID文件的存储路径
   */
  private getDeviceIdPath(): string {
    return path.join(this.getContinueDataPath(), "device-id.txt");
  }

  /**
   * Generate a device ID if not available
   */
  private generateDeviceId(): string {
    return crypto.randomUUID();
  }

  /**
   * Configure settings
   */
  public configure(config: Partial<ManualTypingConfig>) {
    this.config = { ...this.config, ...config };

    // 重启定时器
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
    }

    if (this.config.reportEnabled) {
      this.startPeriodicReporting();
    }
  }

  /**
   * Force immediate report
   */
  public async forceReport() {
    await this.reportEvents();
  }

  /**
   * Get current configuration
   */
  public getConfig(): ManualTypingConfig {
    return { ...this.config };
  }

  /**
   * Get queue status for debugging
   */
  public getQueueStatus() {
    return {
      reportQueueLength: this.reportQueue.length,
      failedEventsLength: this.failedEvents.length,
    };
  }

  /**
   * 检查是否启用追踪
   */
  public isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 销毁服务
   */
  public dispose(): void {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
  }

  /**
   * 输入验证
   */
  private validateInput(
    filepath: string,
    charactersAdded: number,
    linesAdded: number,
    text: string,
  ): boolean {
    // 基本参数验证
    if (!filepath || typeof filepath !== "string") {
      console.warn("Invalid filepath:", filepath);
      return false;
    }

    if (charactersAdded < 0 || linesAdded < 0) {
      console.warn("Invalid characters/lines count:", {
        charactersAdded,
        linesAdded,
      });
      return false;
    }

    if (charactersAdded > 10000 || linesAdded > 1000) {
      console.warn("Suspiciously large input detected:", {
        charactersAdded,
        linesAdded,
      });
      return false;
    }

    if (text && text.length !== charactersAdded) {
      console.warn("Text length mismatch:", {
        textLength: text.length,
        charactersAdded,
      });
      return false;
    }

    return true;
  }

  /**
   * 批量更新统计信息（性能优化）
   */
  private updateStatisticsBatch(
    charactersAdded: number,
    linesAdded: number,
    timestamp: number,
  ): void {
    // 更新基础统计
    this.statistics.totalCharactersTyped += charactersAdded;
    this.statistics.totalLinesTyped += linesAdded;
    this.statistics.totalKeystrokes += 1;
    this.statistics.lastTypingTime = timestamp;
  }

  /**
   * 定期清理过期事件
   */
  private performPeriodicCleanup(now: number): void {
    if (now - this.lastCleanupTime < this.CLEANUP_INTERVAL) {
      return;
    }

    this.lastCleanupTime = now;

    // 清理24小时前的失败事件
    const maxAge = 24 * 60 * 60 * 1000;
    const validFailedEvents = this.failedEvents.filter(
      (event) => now - event.timestamp < maxAge,
    );

    if (validFailedEvents.length !== this.failedEvents.length) {
      const removed = this.failedEvents.length - validFailedEvents.length;
      this.failedEvents = validFailedEvents;
      console.log(`Cleaned up ${removed} old failed events`);
    }
  }

  /**
   * 检查错误是否可重试
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message?.toLowerCase() || "";
    const errorName = error.name || "";

    return (
      this.RETRYABLE_ERRORS.has(errorName) ||
      Array.from(this.RETRYABLE_ERRORS).some((retryableError) =>
        errorMessage.includes(retryableError.toLowerCase()),
      )
    );
  }
}
