import { act, renderHook } from "@testing-library/react";
import {
  AuthType,
  isHubSession,
  isShihuoSession,
} from "core/control-plane/AuthTypes";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupStore } from "../redux/store";
import { AuthProvider, useAuth } from "./Auth";
import { IdeMessengerContext } from "./IdeMessenger";
import { MockIdeMessenger } from "./MockIdeMessenger";

// Mock the IdeMessenger
const mockIdeMessenger = new MockIdeMessenger();

// Test wrapper component
const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  const store = setupStore({ ideMessenger: mockIdeMessenger });

  return (
    <Provider store={store}>
      <IdeMessengerContext.Provider value={mockIdeMessenger}>
        <AuthProvider>{children}</AuthProvider>
      </IdeMessengerContext.Provider>
    </Provider>
  );
};

describe("Auth Context - Multi-Session Support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock responses
    mockIdeMessenger.resetMocks();

    // Set up response handlers for authentication
    mockIdeMessenger.responseHandlers.getControlPlaneSessionInfo =
      async () => ({
        AUTH_TYPE: AuthType.WorkOsProd,
        accessToken: "continue-token",
        account: {
          id: "continue@example.com",
          label: "Continue User",
        },
      });

    mockIdeMessenger.responseHandlers.getShihuoSessionInfo = async () => ({
      AUTH_TYPE: AuthType.ShihuoSSO,
      accessToken: "shihuo-token",
      account: {
        id: "shihuo@example.com",
        label: "Shihuo User",
      },
    });
  });

  it("should initialize with empty multi-session", () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: TestWrapper,
    });

    expect(result.current.multiSession.continueSession).toBeUndefined();
    expect(result.current.multiSession.shihuoSession).toBeUndefined();
    expect(result.current.multiSession.activeSessionType).toBeUndefined();
    expect(result.current.session).toBeUndefined();
  });

  it("should handle Continue login", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: TestWrapper,
    });

    await act(async () => {
      const success = await result.current.login(false);
      expect(success).toBe(true);
    });

    expect(result.current.multiSession.continueSession).toBeDefined();
    expect(result.current.multiSession.continueSession?.AUTH_TYPE).toBe(
      AuthType.WorkOsProd,
    );
    expect(result.current.multiSession.activeSessionType).toBe(
      AuthType.WorkOsProd,
    );
    expect(
      result.current.session && isHubSession(result.current.session)
        ? result.current.session.account.label
        : null,
    ).toBe("Continue User");
  });

  it("should handle Shihuo SSO login", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: TestWrapper,
    });

    // Wait for initialization to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Clear Continue session first
    act(() => {
      result.current.logoutContinue();
    });

    await act(async () => {
      const success = await result.current.loginWithShihuo();
      expect(success).toBe(true);
    });

    expect(result.current.multiSession.shihuoSession).toBeDefined();
    expect(result.current.multiSession.shihuoSession?.AUTH_TYPE).toBe(
      AuthType.ShihuoSSO,
    );
    expect(result.current.multiSession.activeSessionType).toBe(
      AuthType.ShihuoSSO,
    );
    expect(
      result.current.session && isShihuoSession(result.current.session)
        ? result.current.session.account.label
        : null,
    ).toBe("Shihuo User");
  });

  it("should support both sessions simultaneously", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: TestWrapper,
    });

    // Login to Continue
    await act(async () => {
      await result.current.login(false);
    });

    // Login to Shihuo SSO
    await act(async () => {
      await result.current.loginWithShihuo();
    });

    expect(result.current.multiSession.continueSession).toBeDefined();
    expect(result.current.multiSession.shihuoSession).toBeDefined();
    expect(result.current.multiSession.activeSessionType).toBe(
      AuthType.ShihuoSSO,
    ); // Last login becomes active
  });

  it("should switch between sessions", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: TestWrapper,
    });

    // Login to both
    await act(async () => {
      await result.current.login(false);
      await result.current.loginWithShihuo();
    });

    // Switch to Continue session
    act(() => {
      result.current.switchToSession(AuthType.WorkOsProd);
    });

    expect(result.current.multiSession.activeSessionType).toBe(
      AuthType.WorkOsProd,
    );
    expect(
      result.current.session && isHubSession(result.current.session)
        ? result.current.session.account.label
        : null,
    ).toBe("Continue User");

    // Switch to Shihuo session
    act(() => {
      result.current.switchToSession(AuthType.ShihuoSSO);
    });

    expect(result.current.multiSession.activeSessionType).toBe(
      AuthType.ShihuoSSO,
    );
    expect(
      result.current.session && isShihuoSession(result.current.session)
        ? result.current.session.account.label
        : null,
    ).toBe("Shihuo User");
  });

  it("should handle individual logout", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: TestWrapper,
    });

    // Login to both
    await act(async () => {
      await result.current.login(false);
      await result.current.loginWithShihuo();
    });

    // Logout Continue only
    act(() => {
      result.current.logoutContinue();
    });

    expect(result.current.multiSession.continueSession).toBeUndefined();
    expect(result.current.multiSession.shihuoSession).toBeDefined();
    expect(result.current.multiSession.activeSessionType).toBe(
      AuthType.ShihuoSSO,
    );

    // Logout Shihuo only
    act(() => {
      result.current.logoutShihuo();
    });

    expect(result.current.multiSession.shihuoSession).toBeUndefined();
    expect(result.current.multiSession.activeSessionType).toBeUndefined();
  });

  it("should handle complete logout", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: TestWrapper,
    });

    // Login to both
    await act(async () => {
      await result.current.login(false);
      await result.current.loginWithShihuo();
    });

    // Logout all
    act(() => {
      result.current.logout();
    });

    expect(result.current.multiSession.continueSession).toBeUndefined();
    expect(result.current.multiSession.shihuoSession).toBeUndefined();
    expect(result.current.multiSession.activeSessionType).toBeUndefined();
  });
});
