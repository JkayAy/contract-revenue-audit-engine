import { describe, expect, it } from "vitest";
import {
  reconcileBillingAgainstTerms,
  severityForLeakedCents,
} from "../src/workers/auditWorker";
import type { BillingRecord, ContractTerm } from "../src/types/contract";

const ORG_ID = "00000000-0000-0000-0000-000000000000";
const CONTRACT_ID = "11111111-1111-1111-1111-111111111111";

function makeContractTerm(overrides: Partial<ContractTerm> = {}): ContractTerm {
  return {
    id: "term-1",
    organizationId: ORG_ID,
    contractId: CONTRACT_ID,
    termType: "volume_discount",
    clauseText: "Customers exceeding the usage threshold receive a discount.",
    structuredValue: {},
    confidence: 0.95,
    extractedBy: "claude-3-7-sonnet-20250219",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBillingRecord(overrides: Partial<BillingRecord> = {}): BillingRecord {
  return {
    id: "record-1",
    organizationId: ORG_ID,
    contractId: CONTRACT_ID,
    invoiceNumber: "INV-1001",
    lineItem: "Platform usage",
    billedAmountCents: 0,
    expectedAmountCents: null,
    billingPeriodStart: "2026-01-01",
    billingPeriodEnd: "2026-01-31",
    rawPayload: {},
    createdAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("severityForLeakedCents", () => {
  it("classifies leakage below $10 as low", () => {
    expect(severityForLeakedCents(999)).toBe("low");
  });

  it("classifies leakage at the $10 boundary as medium", () => {
    expect(severityForLeakedCents(1_000)).toBe("medium");
  });

  it("classifies leakage at the $250 boundary as high", () => {
    expect(severityForLeakedCents(25_000)).toBe("high");
  });

  it("classifies leakage at the $1,000 boundary as critical", () => {
    expect(severityForLeakedCents(100_000)).toBe("critical");
  });
});

describe("reconcileBillingAgainstTerms - volume discounts", () => {
  it("flags a billing record that never received an earned volume discount", () => {
    const terms = [
      makeContractTerm({
        termType: "volume_discount",
        structuredValue: { threshold: 100, discountPercent: 10 },
      }),
    ];
    const records = [
      makeBillingRecord({
        billedAmountCents: 100_000,
        rawPayload: { grossAmountCents: 100_000, usageQuantity: 150 },
      }),
    ];

    const findings = reconcileBillingAgainstTerms(terms, records);

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toBeDefined();
    expect(finding!.anomalyType).toBe("unapplied_volume_discount");
    expect(finding!.leakedAmountCents).toBe(10_000);
    expect(finding!.severity).toBe("medium");
  });

  it("does not flag a record where the discount was already applied", () => {
    const terms = [
      makeContractTerm({
        termType: "volume_discount",
        structuredValue: { threshold: 100, discountPercent: 10 },
      }),
    ];
    const records = [
      makeBillingRecord({
        billedAmountCents: 90_000,
        rawPayload: { grossAmountCents: 100_000, usageQuantity: 150 },
      }),
    ];

    expect(reconcileBillingAgainstTerms(terms, records)).toHaveLength(0);
  });

  it("does not flag usage that falls below the discount threshold", () => {
    const terms = [
      makeContractTerm({
        termType: "volume_discount",
        structuredValue: { threshold: 100, discountPercent: 10 },
      }),
    ];
    const records = [
      makeBillingRecord({
        billedAmountCents: 100_000,
        rawPayload: { grossAmountCents: 100_000, usageQuantity: 50 },
      }),
    ];

    expect(reconcileBillingAgainstTerms(terms, records)).toHaveLength(0);
  });

  it("skips billing records with no recorded gross amount", () => {
    const terms = [
      makeContractTerm({
        termType: "volume_discount",
        structuredValue: { threshold: 100, discountPercent: 10 },
      }),
    ];
    const records = [
      makeBillingRecord({
        billedAmountCents: 100_000,
        rawPayload: { usageQuantity: 150 },
      }),
    ];

    expect(reconcileBillingAgainstTerms(terms, records)).toHaveLength(0);
  });
});

describe("reconcileBillingAgainstTerms - SLA penalties", () => {
  it("flags a billing record missing an owed SLA penalty credit", () => {
    const terms = [
      makeContractTerm({
        termType: "sla_penalty",
        structuredValue: { penaltyPercent: 20 },
      }),
    ];
    const records = [
      makeBillingRecord({
        billedAmountCents: 50_000,
        rawPayload: { grossAmountCents: 50_000, slaBreach: true },
      }),
    ];

    const findings = reconcileBillingAgainstTerms(terms, records);

    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toBeDefined();
    expect(finding!.anomalyType).toBe("sla_penalty_missing");
    expect(finding!.leakedAmountCents).toBe(10_000);
  });

  it("does not flag a record when no SLA breach occurred", () => {
    const terms = [
      makeContractTerm({
        termType: "sla_penalty",
        structuredValue: { penaltyPercent: 20 },
      }),
    ];
    const records = [
      makeBillingRecord({
        billedAmountCents: 50_000,
        rawPayload: { grossAmountCents: 50_000, slaBreach: false },
      }),
    ];

    expect(reconcileBillingAgainstTerms(terms, records)).toHaveLength(0);
  });

  it("can flag both an unapplied discount and a missing SLA credit on the same record", () => {
    const terms = [
      makeContractTerm({
        id: "term-volume",
        termType: "volume_discount",
        structuredValue: { threshold: 100, discountPercent: 10 },
      }),
      makeContractTerm({
        id: "term-sla",
        termType: "sla_penalty",
        structuredValue: { penaltyPercent: 20 },
      }),
    ];
    const records = [
      makeBillingRecord({
        billedAmountCents: 100_000,
        rawPayload: { grossAmountCents: 100_000, usageQuantity: 150, slaBreach: true },
      }),
    ];

    const findings = reconcileBillingAgainstTerms(terms, records);
    const anomalyTypes = findings.map((finding) => finding.anomalyType).sort();

    expect(findings).toHaveLength(2);
    expect(anomalyTypes).toEqual(["sla_penalty_missing", "unapplied_volume_discount"]);
  });
});
