import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Telemetry } from "../../util/posthog";

export interface AutocompleteStatistics {
  tabAccepts: number;
  escCancels: number;
  totalSuggestions: number;
  acceptanceRate: number;
  cancelRate: number;
}

export interface AutocompleteInteractionEvent {
  type: "accept" | "cancel";
  completionId: string;
  timestamp: string;
  filepath: string;
  fileExtension: string;
  modelName: string;
  modelProvider: string;
  completionLength: number;
  prefixLength: number;
  suggestionDisplayTime?: number; // Time from display to accept/cancel in ms
}

export interface ReportConfig {
  enabled: boolean;
  batchSize: number;
  reportInterval: number; // 上报间隔(ms)
  retryAttempts: number;
  retryDelay: number; // 重试延迟(ms)
}

export class AutocompleteStatisticsService {
  private static instance: AutocompleteStatisticsService | undefined;

  private statistics: AutocompleteStatistics = {
    tabAccepts: 0,
    escCancels: 0,
    totalSuggestions: 0,
    acceptanceRate: 0,
    cancelRate: 0,
  };

  private pendingSuggestions = new Map<
    string,
    {
      displayTime: number;
      completionId: string;
      filepath: string;
      fileExtension: string;
      modelName: string;
      modelProvider: string;
      completionLength: number;
      prefixLength: number;
    }
  >();

  // 上报相关属性
  private reportConfig: ReportConfig = {
    enabled: true,
    batchSize: 10,
    reportInterval: 5 * 60 * 1000, // 5分钟
    retryAttempts: 3,
    retryDelay: 1000,
  };

  private reportQueue: AutocompleteInteractionEvent[] = [];
  private reportTimer: NodeJS.Timeout | null = null;
  private failedEvents: AutocompleteInteractionEvent[] = []; // 存储失败的事件
  private constructor() {
    this.startPeriodicReporting();
  }

  public static getInstance(): AutocompleteStatisticsService {
    if (!AutocompleteStatisticsService.instance) {
      AutocompleteStatisticsService.instance =
        new AutocompleteStatisticsService();
    }
    return AutocompleteStatisticsService.instance;
  }

  public static clearInstance() {
    AutocompleteStatisticsService.instance = undefined;
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
   * Track when a suggestion is displayed to the user
   */
  public trackSuggestionDisplayed(
    completionId: string,
    filepath: string,
    fileExtension: string,
    modelName: string,
    modelProvider: string,
    completionLength: number,
    prefixLength: number,
  ) {
    this.statistics.totalSuggestions++;
    this.pendingSuggestions.set(completionId, {
      displayTime: Date.now(),
      completionId,
      filepath,
      fileExtension,
      modelName,
      modelProvider,
      completionLength,
      prefixLength,
    });

    this.updateRates();
  }

  /**
   * Track when a user accepts a suggestion (Tab key)
   */
  public trackAccept(completionId: string) {
    const pending = this.pendingSuggestions.get(completionId);
    if (pending) {
      this.statistics.tabAccepts++;
      this.pendingSuggestions.delete(completionId);

      const displayTime = Date.now() - pending.displayTime;
      const interactionEvent: AutocompleteInteractionEvent = {
        type: "accept",
        completionId,
        timestamp: new Date().toISOString(),
        filepath: pending.filepath,
        fileExtension: pending.fileExtension,
        modelName: pending.modelName,
        modelProvider: pending.modelProvider,
        completionLength: pending.completionLength,
        prefixLength: pending.prefixLength,
        suggestionDisplayTime: displayTime,
      };

      this.logInteraction(interactionEvent);
      this.queueForReporting(interactionEvent);
      this.updateRates();
    }
  }

  /**
   * Track when a user cancels a suggestion (Esc key or other rejection)
   */
  public trackCancel(completionId: string) {
    const pending = this.pendingSuggestions.get(completionId);
    if (pending) {
      this.statistics.escCancels++;
      this.pendingSuggestions.delete(completionId);

      const displayTime = Date.now() - pending.displayTime;
      const interactionEvent: AutocompleteInteractionEvent = {
        type: "cancel",
        completionId,
        timestamp: new Date().toISOString(),
        filepath: pending.filepath,
        fileExtension: pending.fileExtension,
        modelName: pending.modelName,
        modelProvider: pending.modelProvider,
        completionLength: pending.completionLength,
        prefixLength: pending.prefixLength,
        suggestionDisplayTime: displayTime,
      };

      this.logInteraction(interactionEvent);
      this.queueForReporting(interactionEvent);
      this.updateRates();
    }
  }

  /**
   * Clean up pending suggestions that might have been abandoned
   */
  public cleanupPendingSuggestions(maxAgeMs: number = 30000) {
    const now = Date.now();
    const toRemove: string[] = [];

    this.pendingSuggestions.forEach((pending, completionId) => {
      if (now - pending.displayTime > maxAgeMs) {
        toRemove.push(completionId);
      }
    });

    toRemove.forEach((completionId) => {
      this.trackCancel(completionId);
    });
  }

  /**
   * Reset statistics
   */
  public resetStatistics() {
    this.statistics = {
      tabAccepts: 0,
      escCancels: 0,
      totalSuggestions: 0,
      acceptanceRate: 0,
      cancelRate: 0,
    };
    this.pendingSuggestions.clear();
  }

  /**
   * Update acceptance and cancel rates
   */
  private updateRates() {
    const totalInteractions =
      this.statistics.tabAccepts + this.statistics.escCancels;
    if (totalInteractions > 0) {
      this.statistics.acceptanceRate =
        this.statistics.tabAccepts / totalInteractions;
      this.statistics.cancelRate =
        this.statistics.escCancels / totalInteractions;
    } else {
      this.statistics.acceptanceRate = 0;
      this.statistics.cancelRate = 0;
    }
  }

  /**
   * Log interaction event to data logger and telemetry
   */
  private logInteraction(event: AutocompleteInteractionEvent) {
    // Log to telemetry only for now, as we need to define the schema for data logger
    void Telemetry.capture("autocompleteInteraction", event);
  }

  /**
   * Queue interaction event for reporting
   */
  private queueForReporting(event: AutocompleteInteractionEvent) {
    if (!this.reportConfig.enabled) {
      return;
    }

    this.reportQueue.push(event);

    // 如果队列达到批量大小，立即上报
    if (this.reportQueue.length >= this.reportConfig.batchSize) {
      this.flushReportQueue();
    }
  }

  /**
   * Start periodic reporting
   */
  private startPeriodicReporting() {
    if (!this.reportConfig.enabled) {
      return;
    }

    this.reportTimer = setInterval(() => {
      this.flushReportQueue();
    }, this.reportConfig.reportInterval);
  }

  /**
   * Flush the report queue
   */
  private async flushReportQueue() {
    // 合并正常队列和失败重试队列
    const allEventsToReport = [...this.failedEvents, ...this.reportQueue];
    if (allEventsToReport.length === 0) {
      return;
    }

    // 清空队列
    this.reportQueue = [];
    this.failedEvents = [];

    try {
      await this.sendReport({
        events: allEventsToReport,
        ...this.statistics,
      });
      console.log(
        `Successfully reported ${allEventsToReport.length} autocomplete events`,
      );
      // 上报成功后清空统计数据
      this.resetStatistics();
    } catch (error) {
      console.warn("Failed to report autocomplete data:", error);
      // 将失败的事件加入失败队列，避免与新事件混合
      this.failedEvents.push(...allEventsToReport);

      // 如果失败队列过大，丢弃最老的事件以避免内存泄漏
      const maxFailedEvents = this.reportConfig.batchSize * 2;
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

    for (
      let attempt = 1;
      attempt <= this.reportConfig.retryAttempts;
      attempt++
    ) {
      try {
        await this.uploadLog(payload);
        return;
      } catch (error) {
        lastError = error as Error;
        console.warn(`Report attempt ${attempt} failed:`, error);

        if (attempt < this.reportConfig.retryAttempts) {
          const delay = this.reportConfig.retryDelay * attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    console.error(`All ${this.reportConfig.retryAttempts} attempts failed`);
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

      console.log("bizData", bizData);

      const params: Record<string, any> = {
        pti: {
          id: "continue_autocomplete", // 使用Continue的标识
          biz: JSON.stringify(bizData),
        },
        device_id: deviceId,
        client_code: userInfo.name,
        channel: "Continue", // 使用Continue作为渠道
        action_time: new Date().getTime(),
        APIVersion: "0.6.0",
      };

      let paramsStr = "?";
      Object.keys(params).forEach((key) => {
        let value = params[key];
        if (typeof value === "object") {
          value = JSON.stringify(value);
        } else if (typeof value !== "string") {
          value = value + "";
        }
        paramsStr += `${paramsStr ? "&" : ""}${key}=${encodeURIComponent(value)}`;
      });

      const response = await fetch(
        "https://sh-gateway.shihuo.cn/v4/services/sh-elance-api/track/auto_track",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: paramsStr }),
          signal: AbortSignal.timeout(10000),
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
   * Generate a device ID if not available
   */
  private generateDeviceId(): string {
    return crypto.randomUUID();
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
   * Configure reporting settings
   */
  public configureReporting(config: Partial<ReportConfig>) {
    this.reportConfig = { ...this.reportConfig, ...config };

    // 重启定时器
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
    }

    if (this.reportConfig.enabled) {
      this.startPeriodicReporting();
    }
  }

  /**
   * Force immediate report
   */
  public async forceReport() {
    await this.flushReportQueue();
  }

  /**
   * Get current report configuration
   */
  public getReportConfig(): ReportConfig {
    return { ...this.reportConfig };
  }

  /**
   * Get queue status for debugging
   */
  public getQueueStatus() {
    return {
      reportQueueLength: this.reportQueue.length,
      failedEventsLength: this.failedEvents.length,
      pendingSuggestionsLength: this.pendingSuggestions.size,
    };
  }
}
