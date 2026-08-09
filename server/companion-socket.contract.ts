import type { CompanionRegistry } from "./companion-registry";
import type { Logger } from "./logger";
import { createCompanionSocketServer } from "./companion-socket";

type ExpectedOptions = {
  registry: CompanionRegistry;
  maxPayloadBytes?: number;
  log: Logger;
};

type IsExact<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? Exclude<keyof Actual, keyof Expected> extends never
      ? Exclude<keyof Expected, keyof Actual> extends never
        ? true
        : false
      : false
    : false
  : false;
type Assert<T extends true> = T;

/** Build-time guard for the binding public factory contract in Task 4. */
export type CompanionSocketOptionsContract = Assert<
  IsExact<Parameters<typeof createCompanionSocketServer>[0], ExpectedOptions>
>;
