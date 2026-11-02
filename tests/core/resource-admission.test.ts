import { expect, test } from "bun:test";
import { ResourceAdmission } from "../../src/core/resource-admission";

test("ResourceAdmission reserves synchronously and releases each lease only once", () => {
  const admission = new ResourceAdmission(2);
  const first = admission.acquire();
  const second = admission.acquire();
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(admission.acquire()).toBeUndefined();
  first?.release();
  const replacement = admission.acquire();
  expect(replacement).toBeDefined();
  first?.release();
  expect(admission.acquire()).toBeUndefined();
  second?.release();
  expect(admission.acquire()).toBeDefined();
  expect(admission.acquire()).toBeUndefined();
});
