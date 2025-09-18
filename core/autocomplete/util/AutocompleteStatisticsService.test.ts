import { AutocompleteStatisticsService } from "./AutocompleteStatisticsService";

describe("AutocompleteStatisticsService", () => {
  let service: AutocompleteStatisticsService;

  beforeEach(() => {
    service = AutocompleteStatisticsService.getInstance();
    service.resetStatistics();
  });

  afterEach(() => {
    AutocompleteStatisticsService.clearInstance();
  });

  test("should track suggestion display", () => {
    const completionId = "test-completion-1";
    service.trackSuggestionDisplayed(
      completionId,
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );

    const stats = service.getStatistics();
    expect(stats.totalSuggestions).toBe(1);
    expect(stats.tabAccepts).toBe(0);
    expect(stats.escCancels).toBe(0);
  });

  test("should track acceptance", () => {
    const completionId = "test-completion-1";
    service.trackSuggestionDisplayed(
      completionId,
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );

    service.trackAccept(completionId);

    const stats = service.getStatistics();
    expect(stats.totalSuggestions).toBe(1);
    expect(stats.tabAccepts).toBe(1);
    expect(stats.escCancels).toBe(0);
    expect(stats.acceptanceRate).toBe(1);
    expect(stats.cancelRate).toBe(0);
  });

  test("should track cancellation", () => {
    const completionId = "test-completion-1";
    service.trackSuggestionDisplayed(
      completionId,
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );

    service.trackCancel(completionId);

    const stats = service.getStatistics();
    expect(stats.totalSuggestions).toBe(1);
    expect(stats.tabAccepts).toBe(0);
    expect(stats.escCancels).toBe(1);
    expect(stats.acceptanceRate).toBe(0);
    expect(stats.cancelRate).toBe(1);
  });

  test("should calculate rates correctly with multiple interactions", () => {
    // Display 3 suggestions
    service.trackSuggestionDisplayed(
      "1",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );
    service.trackSuggestionDisplayed(
      "2",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      30,
      5,
    );
    service.trackSuggestionDisplayed(
      "3",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      40,
      8,
    );

    // Accept 2, cancel 1
    service.trackAccept("1");
    service.trackAccept("2");
    service.trackCancel("3");

    const stats = service.getStatistics();
    expect(stats.totalSuggestions).toBe(3);
    expect(stats.tabAccepts).toBe(2);
    expect(stats.escCancels).toBe(1);
    expect(stats.acceptanceRate).toBeCloseTo(0.667, 2); // 2/3
    expect(stats.cancelRate).toBeCloseTo(0.333, 2); // 1/3
  });

  test("should cleanup pending suggestions", () => {
    const completionId = "test-completion-1";
    service.trackSuggestionDisplayed(
      completionId,
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );

    // Mock Date.now to simulate time passing
    const originalNow = Date.now;
    Date.now = jest.fn(() => originalNow() + 35000); // 35 seconds later

    service.cleanupPendingSuggestions(30000); // 30 second max age

    const stats = service.getStatistics();
    expect(stats.escCancels).toBe(1); // Should be cancelled due to timeout

    Date.now = originalNow;
  });

  test("should reset statistics", () => {
    service.trackSuggestionDisplayed(
      "1",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );
    service.trackAccept("1");

    service.resetStatistics();

    const stats = service.getStatistics();
    expect(stats.totalSuggestions).toBe(0);
    expect(stats.tabAccepts).toBe(0);
    expect(stats.escCancels).toBe(0);
    expect(stats.acceptanceRate).toBe(0);
    expect(stats.cancelRate).toBe(0);
  });

  test("should clear persistent data", () => {
    service.trackSuggestionDisplayed(
      "1",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );
    service.trackAccept("1");

    service.clearPersistentData();

    const stats = service.getStatistics();
    expect(stats.totalSuggestions).toBe(0);
    expect(stats.tabAccepts).toBe(0);
    expect(stats.escCancels).toBe(0);
  });

  test("should maintain event order when reporting fails", async () => {
    // Mock the reportData method to simulate failure
    const originalReportData = (service as any).reportData;
    let reportCallCount = 0;
    (service as any).reportData = jest
      .fn()
      .mockImplementation(async (events) => {
        reportCallCount++;
        if (reportCallCount === 1) {
          throw new Error("Network error");
        }
        // Second call succeeds
        return originalReportData.call(service, events);
      });

    // Track multiple events
    service.trackSuggestionDisplayed(
      "1",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );
    service.trackSuggestionDisplayed(
      "2",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      30,
      5,
    );
    service.trackAccept("1");
    service.trackAccept("2");

    // Force report - should fail first time
    await service.forceReport();
    expect(reportCallCount).toBe(1);

    // Check that failed events are in failed queue
    const queueStatus = service.getQueueStatus();
    expect(queueStatus.failedEventsLength).toBeGreaterThan(0);

    // Force report again - should succeed second time
    await service.forceReport();
    expect(reportCallCount).toBe(2);

    // Check that queues are now empty
    const finalQueueStatus = service.getQueueStatus();
    expect(finalQueueStatus.reportQueueLength).toBe(0);
    expect(finalQueueStatus.failedEventsLength).toBe(0);

    // Restore original method
    (service as any).reportData = originalReportData;
  });

  test("should handle queue status correctly", () => {
    const initialStatus = service.getQueueStatus();
    expect(initialStatus.reportQueueLength).toBe(0);
    expect(initialStatus.failedEventsLength).toBe(0);
    expect(initialStatus.pendingSuggestionsLength).toBe(0);
    expect(initialStatus.hasDelayedReportTimer).toBe(false);
    expect(initialStatus.hasPeriodicReportTimer).toBe(true);

    // Add some events
    service.trackSuggestionDisplayed(
      "1",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );
    service.trackAccept("1");

    const statusAfterEvents = service.getQueueStatus();
    expect(statusAfterEvents.pendingSuggestionsLength).toBe(0); // Should be cleared after accept
    expect(statusAfterEvents.hasDelayedReportTimer).toBe(true); // Should have delayed timer
  });

  test("should schedule delayed report for single events", async () => {
    // Mock the sendReport method to track calls
    const originalSendReport = (service as any).sendReport;
    let reportCallCount = 0;
    (service as any).sendReport = jest
      .fn()
      .mockImplementation(async (payload) => {
        reportCallCount++;
        return originalSendReport.call(service, payload);
      });

    // Track a single event
    service.trackSuggestionDisplayed(
      "1",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );
    service.trackAccept("1");

    // Check that delayed timer is set
    const status = service.getQueueStatus();
    expect(status.hasDelayedReportTimer).toBe(true);
    expect(status.reportQueueLength).toBe(1);

    // Wait for delayed report (5 seconds)
    await new Promise((resolve) => setTimeout(resolve, 5100));

    // Check that report was called
    expect(reportCallCount).toBe(1);

    // Restore original method
    (service as any).sendReport = originalSendReport;
  });

  test("should handle shutdown gracefully", async () => {
    // Mock the sendReport method
    const originalSendReport = (service as any).sendReport;
    let reportCallCount = 0;
    (service as any).sendReport = jest
      .fn()
      .mockImplementation(async (payload) => {
        reportCallCount++;
        return originalSendReport.call(service, payload);
      });

    // Add some events
    service.trackSuggestionDisplayed(
      "1",
      "/test/file.ts",
      "ts",
      "gpt-4",
      "openai",
      50,
      10,
    );
    service.trackAccept("1");

    // Simulate shutdown
    await (service as any).flushReportQueue();

    // Check that report was called
    expect(reportCallCount).toBe(1);

    // Restore original method
    (service as any).sendReport = originalSendReport;
  });
});
