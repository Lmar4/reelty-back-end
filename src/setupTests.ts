import { expect } from "@jest/globals";
import "@testing-library/jest-dom";
import type { Mock } from "jest-mock";

declare global {
  namespace jest {
    interface Matchers<R> {
      toHaveBeenCalledWithMatch(...args: any[]): R;
    }
  }
}

// Extend Jest matchers
expect.extend({
  toHaveBeenCalledWithMatch(received: Mock, ...expected: any[]) {
    const pass = received.mock.calls.some((call: any[]) =>
      expected.every((arg, index) =>
        typeof arg === "object"
          ? expect.objectContaining(arg).asymmetricMatch(call[index])
          : arg === call[index]
      )
    );

    return {
      pass,
      message: () =>
        `expected ${received.getMockName()} to have been called with arguments matching ${expected.join(
          ", "
        )}`,
    };
  },
});
